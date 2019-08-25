'use strict'

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as stream from "stream";
import { Lock, Debouncer } from './lock';

const wordRegexp = /[A-Z]?[a-z]+('t)?/g;

let spellDiagnostics: vscode.DiagnosticCollection;

let aspell: child_process.ChildProcess = null;
let aspellLock = new Lock();
let aspellLines: AwaitLine;

// Ignore these words.
let knownIgnore = arrayToHash(["func", "cb", "ctx", "keybase", "esc", "ret", "const", "vscode"]);

// Spellchecking cache
let knownGood = {} as { [word: string]: boolean };
let knownBad = {} as { [word: string]: spellCheckError };

let enabledDocuments: { [uri: string]: boolean } = {};
let lastDocumentURI: string;
let documentDebouncer = new Debouncer(250);

function arrayToHash(array: string[]) {
    return array.reduce((obj, x) => { obj[x] = true; return obj; }, {} as { [k: string]: boolean });
}

interface spellCheckError {
    word: string;
    suggestions: string[];
}

async function checkSpelling(words: string[]): Promise<spellCheckError[]> {
    if (words.length === 0) {
        // Can't have spelling errors if you don't have any words.
        return [];
    }
    await aspellLock.lock();
    console.log("Sending ", words, " to aspell");
    aspell.stdin.write(words.join(" ") + "\n");
    let ret = [];
    let newGoods = arrayToHash(words);
    for (; ;) {
        let line = await aspellLines.getLine();
        if (line == "") {
            break; // aspell signals done
        }
        let error = spellCheckLine(line);
        if (error != null) {
            delete newGoods[error.word];
            ret.push(error);
            knownBad[error.word] = error;
        }
    }
    Object.assign(knownGood, newGoods);
    aspellLock.unlock();
    return ret;
}

function trimCache() {
    const CACHE_LEN_GOAL = 10000;
    function trimOneCache(cache: { [key: string]: any }) {
        const keys = Object.keys(cache);
        for (let i = 0; i < keys.length - CACHE_LEN_GOAL; i++) {
            delete cache[keys[i]];
        }
    }

    trimOneCache(knownGood);
    trimOneCache(knownBad);
    console.log("Cache is: ", Object.keys(knownGood).length, Object.keys(knownBad).length);
}

function triggerSpellcheck(document: vscode.TextDocument) {
    let matches = document.getText().match(wordRegexp);
    let matchesHash = arrayToHash(matches);
    let words = Object.keys(matchesHash);
    words = words.filter((x) => { return x.length > 1 });
    words = words.filter((x) => { return knownIgnore[x.toLowerCase()] === undefined; });
    words = words.filter((x) => { return knownGood[x] === undefined });

    let knownErrors: spellCheckError[] = words.map((x) => {
        return knownBad[x];
    }).filter((x) => { return x != null });

    words = words.filter((x) => { return knownBad[x] === undefined });

    checkSpelling(words).then((errors: spellCheckError[]) => {
        console.log('Errors (from aspell):', errors.length);
        console.log('Errors (from cache):', knownErrors.length);

        errors = errors.concat(knownErrors);

        if (errors.length == 0) {
            spellDiagnostics.set(document.uri, []);
            return;
        }

        let diagnostics: vscode.Diagnostic[] = [];
        let text = document.getText();
        errors.forEach((err) => {
            let index = -1;
            for (; ;) {
                index = text.indexOf(err.word, index + 1);
                if (index == -1) {
                    break;
                }
                let start = document.positionAt(index);
                let end = start.with(undefined, start.character + err.word.length);
                let diag = {
                    severity: vscode.DiagnosticSeverity.Warning,
                    range: new vscode.Range(start, end),
                    message: err.word + "(suggestions: " + err.suggestions.slice(0, 10).join(" ") + ")",
                    source: 'aspell'
                };
                diagnostics.push(diag);
            }
        });
        spellDiagnostics.set(document.uri, diagnostics);

        trimCache();
    });
}

async function triggerSpellcheckIfEnabled(document: vscode.TextDocument) {
    const uriStr = document.uri.toString();
    const enabled = enabledDocuments[uriStr];
    if (!enabled) {
        return;
    }

    if (uriStr == lastDocumentURI) {
        let p = documentDebouncer.queue_or_bust();
        if (p == null) {
            // Spellcheck was already queued for that document, do not start
            // another one.
            return;
        } else {
            await p;
        }
    } else {
        lastDocumentURI = uriStr;
    }
    triggerSpellcheck(document);
}

function triggerDiffSpellcheckIfEnabled(event: vscode.TextDocumentChangeEvent) {
    triggerSpellcheckIfEnabled(event.document);
}

function triggerSpellcheckCommand(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const uri = textEditor.document.uri;
    const uriStr = uri.toString();
    const enabled = enabledDocuments[uriStr];
    if (!enabled) {
        enabledDocuments[uriStr] = true;
        triggerSpellcheck(textEditor.document);
    } else {
        delete enabledDocuments[uriStr];
        spellDiagnostics.delete(uri);
    }
}

const aspellRegexp = /^[\&#] ([a-zA-Z]+) ([0-9]+) ([0-9]+): (.+)$/;
function spellCheckLine(chunk: string): spellCheckError | null {
    if (chunk.length < 1) {
        return null;
    }
    let match = chunk.match(aspellRegexp);
    if (match == null) {
        return null;
    }
    const word = match[1];
    const suggestions = match[4].split(" ");
    return { word, suggestions };
}

class AwaitLine {
    awaiters: ((line: string) => void)[];
    backlog: string[];
    constructor() {
        this.awaiters = [];
        this.backlog = [];
    }

    private feedLine(data: string) {
        if (this.awaiters.length > 0) {
            this.awaiters.shift()(data);
        } else {
            this.backlog.push(data);
        }
    }

    static fromStream(s: stream.Readable): AwaitLine {
        const obj = new AwaitLine();
        let dataBacklog = "";
        s.on('data', function (data) {
            dataBacklog += data;
            let i = dataBacklog.indexOf("\n");
            while (i != -1) {
                const line = dataBacklog.substring(0, i);
                obj.feedLine(line);
                dataBacklog = dataBacklog.substring(i + 1);
                i = dataBacklog.indexOf("\n");
            }
        });
        return obj;
    }

    getLine(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            if (this.backlog.length > 0) {
                resolve(this.backlog.shift());
            } else {
                this.awaiters.push(resolve);
            }
        });
    }
}

export function activate(context: vscode.ExtensionContext): void {
    spellDiagnostics = vscode.languages.createDiagnosticCollection('aspell');

    aspell = child_process.spawn('aspell', ['pipe'])
    aspell.stdout.setEncoding('utf8');
    aspellLines = AwaitLine.fromStream(aspell.stdout);

    // Enter "terse mode" (do not print "*" to indicate correct words, only
    // print suggestions for incorrect words.)
    aspell.stdin.write("!\n");

    aspell.on('close', function () {
        vscode.window.showErrorMessage("Aspell process exited, extension is offline.");
    })

    vscode.workspace.onDidOpenTextDocument(triggerSpellcheckIfEnabled);
    vscode.workspace.onDidChangeTextDocument(triggerDiffSpellcheckIfEnabled);
    vscode.workspace.onDidSaveTextDocument(triggerSpellcheckIfEnabled);

    vscode.workspace.onDidCloseTextDocument((textDocument) => {
        spellDiagnostics.delete(textDocument.uri);
    }, null);

    vscode.commands.registerTextEditorCommand("aspell.spellCheck", triggerSpellcheckCommand);
}
