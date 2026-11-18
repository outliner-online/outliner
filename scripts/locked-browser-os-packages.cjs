// Read declarations from the installed, version-fenced SDK without running its
// installer. Unsupported bundle syntax is diagnostic failure, never a guess.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function declarations(ts, source, platform, browser) {
    if (!["chromium", "firefox"].includes(browser)) throw new Error("Unsupported browser");
    const ast = ts.createSourceFile("coreBundle.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error("Unparseable SDK bundle");
    const matches = [];
    function properties(node) {
        if (!ts.isObjectLiteralExpression(node)) throw new Error("Nonliteral SDK table");
        const result = new Map();
        for (const property of node.properties) {
            if (
                !ts.isPropertyAssignment(property)
                || !(ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))
                || result.has(property.name.text)
            ) throw new Error("Unsupported or duplicate SDK table entry");
            result.set(property.name.text, property.initializer);
        }
        return result;
    }
    function visit(node) {
        if (
            ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isIdentifier(node.left) && node.left.text === "deps" && ts.isObjectLiteralExpression(node.right)
        ) {
            // Other variables named deps are not native dependency tables.
            if (
                node.right.properties.some(p =>
                    ts.isPropertyAssignment(p)
                    && ts.isStringLiteral(p.name) && p.name.text === platform
                )
            ) {
                const groups = properties(properties(node.right).get(platform));
                const selected = {};
                for (const group of ["tools", browser]) {
                    const array = groups.get(group);
                    if (
                        !array || !ts.isArrayLiteralExpression(array)
                        || !array.elements.every(value =>
                            ts.isStringLiteral(value)
                            && /^[a-z0-9][a-z0-9+.-]*$/.test(value.text)
                        )
                    ) {
                        throw new Error("Unsupported SDK package declaration");
                    }
                    selected[group] = array.elements.map(value => value.text);
                }
                matches.push(selected);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(ast);
    if (matches.length !== 1) throw new Error("Missing or ambiguous SDK native dependency table");
    return matches[0];
}

function inspect(root, browser) {
    const packages = path.join(root, "client/node_modules");
    const lock = JSON.parse(fs.readFileSync(path.join(root, "client/package-lock.json"), "utf8"));
    const locked = lock.packages["node_modules/playwright-core"];
    for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
        const installed = JSON.parse(fs.readFileSync(path.join(packages, name, "package.json"), "utf8"));
        if (
            !locked?.version || installed.version !== locked.version
            || installed.version !== lock.packages[`node_modules/${name}`]?.version
        ) {
            throw new Error("Installed SDK differs from lock");
        }
    }
    const bundle = path.join(packages, "playwright-core/lib/coreBundle.js");
    const source = fs.readFileSync(bundle, "utf8");
    // Use the very SDK platform selector the installer uses, including any
    // supported override; do not reimplement distribution/fallback selection.
    const platform = require(bundle).utils.hostPlatform;
    const ts = require(path.join(packages, "typescript"));
    const groups = declarations(ts, source, platform, browser);
    return {
        platform,
        browser,
        version: locked.version,
        lockIntegrity: locked.integrity,
        bundleSha256: crypto.createHash("sha256").update(source).digest("hex"),
        groups,
        packages: [...new Set(Object.values(groups).flat())].sort(),
    };
}

module.exports = { declarations, inspect };
if (require.main === module) {
    try {
        process.stdout.write(JSON.stringify(inspect(process.argv[2], process.argv[3])) + "\n");
    } catch {
        // Do not expose arbitrary environment values or error paths.
        process.stderr.write("Locked SDK native declarations unavailable\n");
        process.exitCode = 1;
    }
}
