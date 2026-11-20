#!/usr/bin/env node
// Parse declarations without executing Functions initialization or reading secrets.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("../client/node_modules/typescript");

function targets(filename) {
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error("Functions source has syntax errors");
    const result = [];
    function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(source).endsWith("setGlobalOptions")) {
            throw new Error("Global Functions options require explicit deployment inventory support");
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const left = node.left;
            const isExport = (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))
                && left.expression.getText(source) === "exports";
            if (left.getText(source) === "module.exports") throw new Error("Dynamic exports are unsupported");
            if (/^exports[.[]/.test(left.getText(source)) && !isExport) {
                throw new Error("Nested exports are unsupported");
            }
            if (isExport) {
                if (
                    !ts.isPropertyAccessExpression(left) || !ts.isExpressionStatement(node.parent)
                    || node.parent.parent !== source || !ts.isCallExpression(node.right)
                    || node.right.expression.getText(source) !== "onRequest"
                ) {
                    throw new Error("Every Function must be a static top-level onRequest export");
                }
                const name = left.name.text;
                if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || result.some(x => x.name === name)) {
                    throw new Error("Invalid or duplicate Function export");
                }
                const options = node.right.arguments[0];
                if (node.right.arguments.length > 1 && !ts.isObjectLiteralExpression(options)) {
                    throw new Error("Dynamic Function options are unsupported");
                }
                if (options && ts.isObjectLiteralExpression(options)) {
                    for (const property of options.properties) {
                        if (ts.isSpreadAssignment(property)) {
                            throw new Error("Dynamic Function options are unsupported");
                        }
                        if (
                            property.name?.getText(source).replace(/["']/g, "") === "region"
                            && (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)
                                || property.initializer.text !== "us-central1")
                        ) {
                            throw new Error("New regions require explicit deployment inventory support");
                        }
                    }
                }
                result.push({ name, region: "us-central1" });
            }
        }
        if (
            ts.isCallExpression(node)
            && ["Object.assign", "Object.defineProperty"].includes(node.expression.getText(source))
            && node.arguments.some(arg => arg.getText(source) === "exports")
        ) throw new Error("Dynamic exports are unsupported");
        ts.forEachChild(node, visit);
    }
    visit(source);
    if (!result.length) throw new Error("No Function exports found");
    return result;
}

if (require.main === module) {
    const filename = process.argv[2] || path.resolve(__dirname, "../functions/index.js");
    console.log(JSON.stringify(targets(filename)));
}
module.exports = { targets };
