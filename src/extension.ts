'use strict'

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as stream from "stream";
import { Lock } from './lock';

const wordRegexp = /[A-Z]?[a-z]+('t)?/g;

let spellDiagnostics: vscode.DiagnosticCollection;

let aspell: child_process.ChildProcess = null;
let aspellLock = new Lock();
let aspellLines: AwaitLine;
let knownGood = {};

function arrayToHash(array: string[]) {
    return array.reduce((obj, x) => { obj[x] = true; return obj; }, {});
}

interface spellCheckError {
    word: string;
    suggestions: string[];
}

async function checkSpelling(words: string[]): Promise<spellCheckError[]> {
    await aspellLock.lock();
    console.log("Sending ", words, " to aspell");
    aspell.stdin.write(words.join(" ") + "\n");
    let ret = [];
    let wordHash = arrayToHash(words);
    for (; ;) {
        let line = await aspellLines.getLine();
        console.log("Lines got us line:", line);
        if (line == "") {
            break; // aspell signals done
        }
        let error = spellCheckLine(line);
        if (error != null) {
            delete wordHash[error.word];
            ret.push(error);
        }
    }
    Object.assign(knownGood, wordHash);
    aspellLock.unlock();
    return ret;
}

function triggerSpellcheck(document: vscode.TextDocument) {
    let matches = document.getText().match(wordRegexp);
    console.log('Trigger');
    let matchesHash = arrayToHash(matches);
    let words = Object.keys(matchesHash);
    words = words.filter((x) => { return x.length > 1 });
    words = words.filter((x) => { return knownGood[x] === undefined });

    checkSpelling(words).then((errors: spellCheckError[]) => {
        console.log('Errors:', errors);
        if (errors.length == 0) {
            spellDiagnostics.set(document.uri, []);
            return;
        }

        let diagnostics: vscode.Diagnostic[] = [];
        let text = document.getText();
        errors.forEach((err) => {
            let start = document.positionAt(text.indexOf(err.word));
            let end = start.with(undefined, start.character + err.word.length);
            diagnostics.push({
                severity: vscode.DiagnosticSeverity.Warning,
                range: new vscode.Range(start, end),
                message: err.word + "(suggestions: " + err.suggestions.slice(0, 10).join(" ") + ")",
                source: 'aspell'
            });
        });
        console.log(diagnostics);
        spellDiagnostics.set(document.uri, diagnostics);
    });
}

function triggerDiffSpellcheck(event: vscode.TextDocumentChangeEvent) {
    triggerSpellcheck(event.document);
}

const aspellRegexp = /^\& ([a-zA-Z]+) ([0-9]+) ([0-9]+): (.+)$/;
function spellCheckLine(chunk: string): spellCheckError | null {
    if (chunk.length < 1) {
        return null;
    }
    let match = chunk.match(aspellRegexp);
    if (match != null) {
        const word = match[1];
        const suggestions = match[4].split(" ");
        return { word, suggestions };
    } else {
        return null;
    }
}

function emitLines(s: stream.Readable) {
    let backlog = "";
    s.on('data', function (data) {
        backlog += data;
        let i = backlog.indexOf("\n")
        while (i != -1) {
            const line = backlog.substring(0, i);
            console.log("emitLines emitting:", line);
            s.emit('line', line);
            backlog = backlog.substring(i + 1);
            i = backlog.indexOf("\n");
        }
    });
}

class AwaitLine {
    awaiters: ((string) => void)[];
    backlog: string[];
    constructor() {
        this.awaiters = [];
        this.backlog = [];
    }

    static fromStream(s: stream.Readable): AwaitLine {
        const obj = new AwaitLine();
        emitLines(s);
        s.on('line', function (data: string) {
            if (obj.awaiters.length > 0) {
                obj.awaiters.shift()(data);
            } else {
                obj.backlog.push(data);
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
    console.log("hello michal");
    console.log(context.subscriptions);

    spellDiagnostics = vscode.languages.createDiagnosticCollection('aspell');

    aspell = child_process.spawn('aspell', ['pipe'])
    aspell.stdout.setEncoding('utf8');
    aspellLines = AwaitLine.fromStream(aspell.stdout);

    aspell.on('close', function () {
        console.log('Aspell closed');
        // kill the extension, we don't have a way to recover.
        process.exit(1);
    })

    vscode.workspace.onDidOpenTextDocument(triggerSpellcheck, this);
    vscode.workspace.onDidChangeTextDocument(triggerDiffSpellcheck, this);
    vscode.workspace.onDidSaveTextDocument(triggerSpellcheck, this);
    vscode.workspace.onDidCloseTextDocument((textDocument) => {
        spellDiagnostics.delete(textDocument.uri);
    }, null);
}
