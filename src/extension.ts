'use strict'

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as stream from "stream";
import { Lock, Debouncer } from './lock';

let spellDiagnostics: vscode.DiagnosticCollection;

let aspell: child_process.ChildProcess = null;
let aspellLock = new Lock();
let aspellLines: AwaitLine;

// Ignore these words.
let knownIgnore = arrayToHash([
    // Various language keywords
    "func", "isnt", "noop", "const", "instanceof", "boolean", "async",
    // Often used variable names
    "cb", "ctx", "esc", "ret", "utils", "param",
    // Product names
    "vscode", "keybase",
    // Other keywords commonly found in code
    "tokenize", "stringify", "fs", "vm", "http", "https",
]);

type spellCheckError = {
    word: string;
    suggestions: string[];
}

type spellCheckErrorHash = { [word: string]: spellCheckError }

// Spellchecking cache
let knownGood = {} as { [word: string]: boolean };
let knownBad = {} as spellCheckErrorHash;

let enabledDocuments: { [uri: string]: boolean } = {};
let lastDocumentURI: string;
let documentDebouncer = new Debouncer(250);

function arrayToHash(array: string[]) {
    return array.reduce((obj, x) => { obj[x] = true; return obj; }, {} as { [k: string]: boolean });
}

async function checkSpelling(words: string[]): Promise<spellCheckError[]> {
    if (words.length === 0) {
        // Can't have spelling errors if you don't have any words.
        console.log("checkSpelling: Called with empty list, no-op.")
        return [];
    }
    await aspellLock.lock();
    console.log("checkSpelling: Sending ", words, " to aspell");
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
    console.log("Cache sizes are:", "knownGood", Object.keys(knownGood).length, "knownBad", Object.keys(knownBad).length);
}

function triggerSpellcheck(document: vscode.TextDocument) {
    type matchWord = { word: string, index: number, length: number }

    const wordRegexp = /[A-Z]?[a-z]+('t)?/g;
    const text = document.getText();
    const matches = [] as Array<matchWord>;
    let array1: RegExpExecArray
    while ((array1 = wordRegexp.exec(text)) !== null) {
        const word = array1[0]
        const wordLength = wordRegexp.lastIndex - array1.index
        if (array1.length > 1) {
            matches.push({ word, index: array1.index, length: wordLength });
        }
    }

    // arrayToHash > Object.keys to deduplicate
    const words = Object.keys(arrayToHash(matches.map((x) => x.word)))
        .filter((x) => knownIgnore[x.toLowerCase()] === undefined)
        .filter((x) => knownGood[x] === undefined)
        .filter((x) => knownBad[x] === undefined);

    checkSpelling(words).then((errors: spellCheckError[]) => {
        // Ignore `errors` argument, operate solely on `knownGood` and
        // `knownBad` objects that `checkSpelling` is modifying.
        const diagnostics = [] as Array<vscode.Diagnostic>;
        matches.forEach((textMatch) => {
            const { word, index, length } = textMatch;
            const error = knownBad[word];
            if (error && knownBad.hasOwnProperty(word)) {
                const start = document.positionAt(index);
                const end = start.with(undefined, start.character + length)
                const diag = {
                    severity: vscode.DiagnosticSeverity.Warning,
                    range: new vscode.Range(start, end),
                    message: word + " (suggestions: " + error.suggestions.slice(0, 10).join(" ") + ")",
                    source: 'aspell'
                };
                diagnostics.push(diag);
            }
        })
        spellDiagnostics.set(document.uri, diagnostics);

        if (errors.length > 0) {
            // Only run trim if aspell call yielded results (so cache was
            // modified).
            trimCache();
        }
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
