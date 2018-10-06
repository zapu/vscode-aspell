'use strict'

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as stream from "stream";

const wordRegexp = /[A-Z]?[a-z]+/g;

let aspell: child_process.ChildProcess = null;

function triggerSpellcheck(document: vscode.TextDocument) {
    let matches = document.getText().match(wordRegexp);
    console.log('Trigger');
    let matchesHash = matches.reduce((obj, x) => { obj[x] = true; return obj; }, {});
    const words = Object.keys(matchesHash);
    console.log(words);
    aspell.stdin.write(words.join(" ") + "\n");
}

function triggerDiffSpellcheck(event: vscode.TextDocumentChangeEvent) {
    triggerSpellcheck(event.document);
}

const aspellRegexp = /^\& ([a-zA-Z]+) ([0-9]+) ([0-9]+): (.+)$/;
function spellCheckLine(chunk: string) {
    if(chunk.length < 1) {
        return;
    }
    let match = chunk.match(aspellRegexp);
    if(match != null) {
        const word = match[1];
        const suggestions = match[4];
        console.log('Aspell returns:', match);
    }
}

function emitLines(s: stream.Readable) {
    let backlog = "";
    s.on('data', function (data) {
        backlog += data;
        let i = backlog.indexOf("\n")
        while (i != -1) {
            const line = backlog.substring(0, i);
            s.emit('line', line);
            backlog = backlog.substring(i + 1);
            i = backlog.indexOf("\n");
        }
    });
}

export function activate(context: vscode.ExtensionContext): void {
    console.log("hello michal");
    console.log(context.subscriptions);

    aspell = child_process.spawn('aspell', ['pipe'])
    aspell.stdout.setEncoding('utf8');
    emitLines(aspell.stdout);

    aspell.stdout.on('line', spellCheckLine);

    aspell.on('close', function () {
        console.log('Aspell closed');
    })

    aspell.stdin.write("Hello World\n");

    vscode.workspace.onDidOpenTextDocument(triggerSpellcheck, this);
    vscode.workspace.onDidChangeTextDocument(triggerDiffSpellcheck, this);
    vscode.workspace.onDidSaveTextDocument(triggerSpellcheck, this);
}
