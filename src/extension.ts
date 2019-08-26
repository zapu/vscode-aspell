'use strict'

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as stream from "stream";
import { Lock, Debouncer } from './lock';

// Variables and types

let spellDiagnostics: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;

// Aspell child process and helpers.
let aspell: child_process.ChildProcess = null;
let aspellLock = new Lock();
let aspellLines: AwaitLine;

// Ignore these words.
let knownIgnore = arrayToSet([
    // Various language keywords
    "func", "isnt", "noop", "const", "instanceof", "boolean", "async", "concat",
    // Often used variable names
    "cb", "ctx", "esc", "ret", "utils", "param", "args", "config", "json", "env",
    // Product names
    "vscode", "keybase",
    // Other keywords commonly found in code
    "tokenize", "stringify", "fs", "vm", "http", "https", "uri", "url",
    // Other words
    "ok",
]);

type spellCheckError = {
    word: string;
    suggestions: string[];
}

// Spellchecking cache.
let knownGood = new Set<string>(); // set of known good words
let knownBad = new Map<string, spellCheckError>(); // map of known errors for words

// Enable or disable spellchecking either everywhere or by document.
let enabledAllDocuments = false;
let enabledDocuments = new Set<string>();

let lastDocumentURI: string;
let documentDebouncer = new Debouncer(250);

// --------------------

function isUriEnabled(uri: string) {
    return enabledAllDocuments || enabledDocuments.has(uri);
}

function arrayToSet<K>(array: K[]) : Set<K> {
    const set = new Set<K>();
    array.forEach((x) => set.add(x))
    return set;
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
    let newGoods = arrayToSet(words);
    for (; ;) {
        let line = await aspellLines.getLine();
        if (line == "") {
            break; // aspell signals done
        }
        let error = spellCheckLine(line);
        if (error != null) {
            newGoods.delete(error.word);
            ret.push(error);
            knownBad.set(error.word, error);
        }
    }
    newGoods.forEach((x) => knownGood.add(x));
    aspellLock.unlock();
    return ret;
}

function trimCache() {
    const CACHE_LEN_GOAL = 10000;
    function trimOneCache(cache: Set<string> | Map<string, any>) {
        if(cache.size <= CACHE_LEN_GOAL) {
            return;
        }
        const toDelete = [] as Array<string>;
        let goal = cache.size;
        cache.forEach((x : string) => {
            if (goal > CACHE_LEN_GOAL) {
                toDelete.push(x);
                goal--;
            }
        })
        toDelete.forEach((x) => cache.delete(x));
    }

    trimOneCache(knownGood);
    trimOneCache(knownBad);
    console.log("Cache sizes are:", "knownGood", knownGood.size, "knownBad", knownBad.size);
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

    // arrayToSet > values to deduplicate
    const words = Array.from(arrayToSet(matches.map((x) => x.word)).values())
        .filter((x) => !knownIgnore.has(x.toLowerCase()))
        .filter((x) => !knownGood.has(x))
        .filter((x) => !knownBad.has(x))

    checkSpelling(words).then((errors: spellCheckError[]) => {
        // Ignore `errors` argument, operate solely on `knownGood` and
        // `knownBad` objects that `checkSpelling` is modifying.
        const diagnostics = [] as Array<vscode.Diagnostic>;
        matches.forEach((textMatch) => {
            const { word, index, length } = textMatch;
            const error = knownBad.get(word);
            if (error) {
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
    if (!isUriEnabled(uriStr)) {
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

function toggleSpellcheckCommand(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const uri = textEditor.document.uri;
    const uriStr = uri.toString();
    if (!enabledDocuments.has(uriStr)) {
        enabledDocuments.add(uriStr);
        triggerSpellcheck(textEditor.document);
    } else {
        enabledDocuments.delete(uriStr);
        spellDiagnostics.delete(uri);
    }

    updateStatusBar(textEditor);
}

function toggleSpellcheckAllCommand(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    enabledAllDocuments = !enabledAllDocuments;
    if (enabledAllDocuments) {
        // Just turned on - spellcheck current document.
        triggerSpellcheck(textEditor.document);
    } else {
        // Just turned off - clear all diagnostics for documents that are not
        // explicitly enabled.
        const toDelete = [] as Array<vscode.Uri>
        spellDiagnostics.forEach((uri) => {
            if (!isUriEnabled(uri.toString())) {
                toDelete.push(uri);
            }
        })
        toDelete.forEach((uri) => spellDiagnostics.delete(uri));
        trimCache();
    }

    updateStatusBar(textEditor);
}

function textEditorChanged(textEditor: vscode.TextEditor) {
    const uri = textEditor.document.uri;
    if (isUriEnabled(uri.toString()) && !spellDiagnostics.has(uri)) {
        // Changed to a document that we should be checking but there were no
        // diagnostics - recheck.
        triggerSpellcheck(textEditor.document);
    }
    updateStatusBar(textEditor);
}

function updateStatusBar(textEditor?: vscode.TextEditor) {
    if (enabledAllDocuments) {
        statusBarItem.text = "Aspell (all)";
        statusBarItem.show();
    } else if (textEditor) {
        if (enabledDocuments.has(textEditor.document.uri.toString())) {
            statusBarItem.text = "Aspell";
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
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
    vscode.workspace.onDidSaveTextDocument(triggerSpellcheckIfEnabled);
    vscode.workspace.onDidChangeTextDocument(triggerDiffSpellcheckIfEnabled);

    vscode.workspace.onDidCloseTextDocument((textDocument) => {
        spellDiagnostics.delete(textDocument.uri);
    }, null);

    vscode.window.onDidChangeActiveTextEditor(textEditorChanged);

    vscode.commands.registerTextEditorCommand("aspell.spellCheck", toggleSpellcheckCommand);
    vscode.commands.registerTextEditorCommand("aspell.spellCheckAll", toggleSpellcheckAllCommand);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
}
