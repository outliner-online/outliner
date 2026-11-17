import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated executable control fixtures, never a Firebase/HTTP success oracle.
export function rolloutFixture(repo: string, scenario = "success", source?: string) {
    const dir = mkdtempSync(join(tmpdir(), "firebase-serial-control-"));
    for (const name of ["scripts", "functions", "bin", "home", "client"]) mkdirSync(join(dir, name));
    for (const name of ["deploy-firebase-serial.py", "firebase-function-targets.cjs"]) {
        copyFileSync(join(repo, "scripts", name), join(dir, "scripts", name));
    }
    symlinkSync(join(repo, "client/node_modules"), join(dir, "client/node_modules"), "dir");
    writeFileSync(join(dir, "functions/index.js"),
        source || "exports.first = onRequest(() => {});\nexports.second = onRequest(() => {});\n");
    writeFileSync(join(dir, "functions/package.json"), "{}\n");
    writeFileSync(join(dir, "functions/package-lock.json"), "{}\n");
    writeFileSync(join(dir, "firebase.json"),
        JSON.stringify({ functions: [{ source: "functions", codebase: "default" }] }));
    const zip = execFileSync("python3", ["-c", `
import sys,io,zipfile,pathlib,base64
root=pathlib.Path(sys.argv[1]);case=sys.argv[2];b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 for name in ['index.js','package.json','package-lock.json']:
  if case=='missing-source' and name=='package-lock.json':continue
  content=(root/'functions'/name).read_bytes()
  if (case=='wrong-source' and name=='index.js') or (case=='wrong-dependency' and name=='package.json'):content+=b' '
  z.writestr(name,content)
 if case=='duplicate-source':z.writestr('index.js',b'wrong')
print(base64.b64encode(b.getvalue() if case!='invalid-zip' else b'not a zip').decode())
`, dir, scenario], { encoding: "utf8" }).trim();
    const common = `
const fs = require('node:fs');
const a = process.argv.slice(2), scenario = process.env.SCENARIO;
const log = row => fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(row) + '\\n');
`;
    const firebase = join(dir, "scripts/firebase-cli.sh");
    writeFileSync(firebase, `#!/usr/bin/env node
${common}
const only = a[a.indexOf('--only') + 1]; log(['firebase', only]);
if (scenario === 'timeout' && only.startsWith('functions:')) { setTimeout(() => {}, 8000); }
else if ((['command-failure','active-version-text'].includes(scenario) && only === 'functions:first') ||
 (scenario === 'second-failure' && only === 'functions:second') ||
 (scenario === 'other-failure' && !only.startsWith('functions:'))) {
 console.log('is the current active version; must-not-be-retained'); process.exit(7);
}
`);
    chmodSync(firebase, 0o755);
    const gcloud = join(dir, "bin/gcloud");
    writeFileSync(gcloud, `#!/usr/bin/env node
${common}
log(['gcloud', ...a]);
if (a[0] === 'functions' && a[1] === 'list') {
 const names=['first','second']; if (scenario==='retired-function') names.push('retired');
 console.log(JSON.stringify(names.map(n=>({name:'projects/demo-rollout/locations/us-central1/functions/'+n}))));
} else if (a[0] === 'functions' && a[1] === 'describe') {
 const n = a[2]; fs.writeFileSync(process.env.STATE, n);
 console.log(JSON.stringify({name:'projects/' + (scenario==='wrong-project'?'other':'demo-rollout') + '/locations/us-central1/functions/' + n,
 state:'ACTIVE', serviceConfig:{service:'projects/demo-rollout/locations/us-central1/services/'+n.toLowerCase(), revision:n+'-new'},
 buildConfig:{source:{storageSource:{bucket:'fixture',object:n+'.zip',generation:'1'}}}}));
} else if (a[0] === 'run') {
 const n = fs.readFileSync(process.env.STATE, 'utf8');
 const bad = scenario==='unready' || (scenario==='late-drift' && n==='first' && fs.readFileSync(process.env.CALL_LOG,'utf8').includes('functions:second'));
 const conditions=['Ready','ConfigurationsReady','RoutesReady'].map(type=>({type,status:bad?'False':'True'}));
 console.log(JSON.stringify({status:{conditions,latestCreatedRevisionName:n+'-new',latestReadyRevisionName:n+(bad?'-old':'-new'),
 traffic:scenario==='split-traffic'?[{revisionName:n+'-new',percent:50},{revisionName:n+'-old',percent:50}]:
 [{revisionName:n+(bad||scenario==='old-traffic'?'-old':'-new'),percent:100}]}}));
} else if (a[0] === 'storage') {
 if (scenario === 'storage-failure') process.exit(9);
 process.stdout.write(Buffer.from(process.env.ZIP_PAYLOAD,'base64'));
} else { process.exit(8); }
`);
    chmodSync(gcloud, 0o755);
    const receipt = join(dir, "receipt");
    const execute = () =>
        spawnSync("python3", [join(dir, "scripts/deploy-firebase-serial.py"), "--project", "demo-rollout",
            "--receipt-dir", receipt, "--verify-timeout", "0", "--command-timeout", scenario === "timeout" ? "2" : "8"],
            {
                cwd: dir,
                encoding: "utf8",
                timeout: 25000,
                // Never inherit production/GitHub credentials into control fixtures.
                env: {
                    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
                    HOME: join(dir, "home"),
                    SCENARIO: scenario,
                    CALL_LOG: join(dir, "calls"),
                    STATE: join(dir, "state"),
                    ZIP_PAYLOAD: zip,
                },
            });
    const calls = () => {
        try {
            return readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
        } catch {
            return [];
        }
    };
    return { dir, execute, calls, receipt: () => JSON.parse(readFileSync(join(receipt, "receipt.json"), "utf8")) };
}
