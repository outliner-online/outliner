"""GitHub-native admission before unchanged issue reconciliation; never live writes."""

import copy
from datetime import timedelta
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import yaml
import test_ci_duration_monitor as fixtures
from test_ci_duration_monitor import GitHub, NOW, REPOSITORY, Result, job, stamp
from scripts import ci_duration_monitor as monitor

ROOT = Path(__file__).resolve().parents[2]


class PolicyTests(unittest.TestCase):
    setUp = fixtures.MonitorTests.setUp
    run_cli = fixtures.MonitorTests.run_cli
    report = fixtures.MonitorTests.report

    def repository_sources(self):
        workflows = monitor.read_config(ROOT / '.github/ci-duration-monitor.json')
        self.github.sources = {str(p.relative_to(ROOT)): p.read_text() for p in (ROOT / '.github').rglob('*.yml')}
        for workflow in workflows:
            for family in workflow.families:
                for source in family.source_paths:
                    self.github.sources[source] = (ROOT / source).read_text()
        return workflows

    def test_single_completed_separated_execution_is_a_candidate(self):
        self.assertEqual(self.run_cli(recurring=False), 0)
        self.assertEqual(len(self.github.issues), 1)
        self.assertEqual(self.report()['admission'][0]['classification'], 'qualifies-new')

    def test_owner_intervals_under_separated_contract_qualify_before_existing_duplicates(self):
        workflows = self.repository_sources()
        workflow = next(w for w in workflows if w.path.endswith('/ci.yml'))
        records = json.loads((ROOT / 'scripts/tests/fixtures/ci-duration/owner-test-steps.json').read_text())
        self.github.runs, self.github.jobs = [], {}
        # These exact API intervals are applied to the reviewed current separated
        # execution contract. Historical server wrapper timing is not retroactively
        # certified as pure test time: live provenance still requires that contract.
        for row in records:
            run = copy.deepcopy(row['run'])
            run.update(repository={'full_name':REPOSITORY}, head_repository={'full_name':REPOSITORY})
            if run['id'] not in [r['id'] for r in self.github.runs]: self.github.runs.append(run)
            self.github.jobs.setdefault((run['id'], row['job']['run_attempt']), []).append(row['job'])
            # The real latest view can report attempt 2. Older attempts are empty
            # in this boundary fixture; no duplicate execution is manufactured.
            for attempt in range(1, row['job']['run_attempt']): self.github.jobs.setdefault((run['id'], attempt), [])
        now = NOW + timedelta(hours=10)
        with patch.object(monitor, 'logger'):
            report = monitor.run_monitor(self.github, (workflow,), REPOSITORY, 'ignored', now=now, lookback_hours=48, publish=False)
        admitted = {a['family']: a for a in report['admission'] if a['qualifying_job_ids']}
        self.assertEqual(set(admitted), {'unit-tests','server-tests','e2e-chromium'})
        self.assertEqual(report['admission_summary']['qualifying_candidates'],3)
        self.assertEqual(report['admission_summary']['qualifying_families_new'],3)
        measured = {s['job_id']:s['qualifying_test_step_seconds'] for o in report['observations'] for s in o['samples'] if s['diagnostic_reason'] is None}
        self.assertEqual(measured, {136731411619:721,136731411435:802,136798530012:1003})
        observations = [o for o in monitor.collect(self.github,(workflow,),NOW-timedelta(days=2),monitor.CurrentSource(self.github,monitor._call,REPOSITORY))[0] if o.samples]
        for row in records:
            observation = next(o for o in observations if o.family.key==row['family'])
            sample = next(s for s in observation.samples if s.job_id==row['job']['id'])
            key = monitor._key(REPOSITORY,observation)
            body = key+'\n\nOwner-reviewed Objective and Requirements stay exactly as queued.\n'+sample.marker
            self.github.issues.append({'number':row['existing_issue'],'state':'open','closed_at':None,'body':body,'labels':[{'name':monitor.MANAGED_LABEL},{'name':monitor.READY_LABEL}]})
            self.github.comments[row['existing_issue']] = [{'body':key}]
        original_bodies = [i['body'] for i in self.github.issues]
        self.github.calls.clear()
        for _ in range(2):
            with patch.object(monitor,'logger'):
                report=monitor.run_monitor(self.github,(workflow,),REPOSITORY,'ignored',now=now,lookback_hours=48,publish=True)
            self.assertEqual({a['classification'] for a in report['admission'] if a['qualifying_job_ids']},{'qualifies-existing'})
            self.assertEqual({a['action'] for a in report['actions']},{'unchanged'})
        self.assertEqual(self.github.mutations,[])
        self.assertEqual([i['body'] for i in self.github.issues],original_bodies)
        self.assertFalse(any('/logs' in path or '/artifacts' in path for _,path,_ in self.github.calls))

    def test_old_mixed_server_boundary_is_not_retroactively_certified(self):
        workflows=self.repository_sources();workflow=next(w for w in workflows if w.path.endswith('/ci.yml'))
        row=next(r for r in json.loads((ROOT/'scripts/tests/fixtures/ci-duration/owner-test-steps.json').read_text()) if r['family']=='server-tests')
        run=copy.deepcopy(row['run']);run.update(repository={'full_name':REPOSITORY},head_repository={'full_name':REPOSITORY})
        self.github.runs=[run];self.github.jobs={(run['id'],1):[row['job']]}
        original=self.github.request
        def historical(method,path,payload=None):
            if path.startswith('contents/scripts/run-server-test-command.sh') and 'ref='+run['head_sha'] in path:return Result(404,{})
            return original(method,path,payload)
        with patch.object(self.github,'request',side_effect=historical), patch.object(monitor,'logger'):
            report=monitor.run_monitor(self.github,(workflow,),REPOSITORY,'ignored',now=NOW+timedelta(hours=10),lookback_hours=48,publish=False)
        self.assertEqual(report['admission_summary']['qualifying_candidates'],0)
        self.assertEqual(report['observations'][2]['samples'][0]['diagnostic_reason'],'workflow/test entrypoint differs from current default branch')
        self.assertEqual(self.github.mutations,[])

    def test_all_five_owner_closed_false_shapes_remain_nonpublished(self):
        workflows=self.repository_sources()
        records=json.loads((ROOT/'scripts/tests/fixtures/ci-duration/owner-closed.json').read_text())
        durations={5998:708,5999:698,6000:603,6001:640,6003:657}
        for row in records:
            with self.subTest(issue=row['issue']):
                path='.github/workflows/ci.yml' if row['issue']==5998 else '.github/workflows/ci-onprem.yml' if row['issue']==5999 else '.github/workflows/ci-schedule-hosting-page.yml' if row['issue']==6000 else '.github/workflows/ci-schedule-hosting-service.yml' if row['issue']==6001 else '.github/workflows/ci-test-container-build.yml'
                workflow=next(w for w in workflows if w.path==path)
                candidate=job(row['job_id'],durations[row['issue']],name=row['name'],conclusion=row['conclusion'])
                candidate['steps']=copy.deepcopy(row['steps'])
                for step in candidate['steps']:
                    seconds=monitor._seconds(step.get('started_at'),step.get('completed_at'))
                    if seconds is not None: step.update(started_at=stamp(-seconds),completed_at=stamp())
                self.github.runs=[{**GitHub().runs[0],'path':path}]
                self.github.jobs={(10,1):[candidate]}
                self.github.issues,self.github.comments,self.github.calls=[],{},[]
                source=monitor.CurrentSource(self.github,monitor._call,REPOSITORY)
                observations,_=monitor.collect(self.github,(workflow,),NOW-timedelta(days=2),source)
                observation=next(o for o in observations if o.samples)
                self.github.issues=[{'number':row['issue'],'state':'closed','closed_at':stamp(-1),'body':monitor._key(REPOSITORY,observation),'labels':[{'name':monitor.MANAGED_LABEL}]}]
                for _ in range(2):
                    with patch.object(monitor,'logger'):
                        report=monitor.run_monitor(self.github,(workflow,),REPOSITORY,'ignored',now=NOW,lookback_hours=48,publish=True)
                    self.assertEqual(report['actions'],[])
                    self.assertTrue(all(s['diagnostic_reason'] for o in report['observations'] for s in o['samples']))
                self.assertEqual(self.github.mutations,[])
                self.assertEqual(self.github.issues[0]['state'],'closed')

    def test_current_main_manual_and_verified_pr_routes(self):
        for event in ['push','workflow_dispatch','pull_request']:
            with self.subTest(event=event):
                self.github=GitHub()
                run=self.github.runs[0];run['event']=event
                if event=='pull_request':
                    run['head_branch']='current-feature'
                    run['pull_requests']=[{'base':{'ref':'main','repo':{'id':987528414}},'head':{'ref':'current-feature','repo':{'id':987528414}}}]
                self.assertEqual(self.run_cli(recurring=False),0)
                self.assertEqual(len(self.github.issues),1)

    def test_current_browser_variants_use_steps_not_reporter_format(self):
        workflows=self.repository_sources();workflow=next(w for w in workflows if w.path.endswith('/ci.yml'))
        for variant in ['new-4','new-3a','new-3b','firefox-selection-new','onprem']:
            self.github.runs=[{**GitHub().runs[0],'path':workflow.path}]
            candidate=job(seconds=900,name='e2e-test / e2e-test ('+variant+')')
            candidate['steps'][0]['name']='Run E2E tests ('+variant+')'
            self.github.jobs={(10,1):[candidate]};self.github.issues=[]
            with patch.object(monitor,'logger'):
                result=monitor.run_monitor(self.github,(workflow,),REPOSITORY,'ignored',now=NOW,lookback_hours=48,publish=False)
            admitted=[a for a in result['admission'] if a['qualifying_job_ids']]
            self.assertEqual(len(admitted),0 if variant=='onprem' else 1)

    def test_unknown_branch_fork_base_variant_and_source_are_diagnostic(self):
        for mode in ['branch','unverified-pr','foreign-base','retired','source','inactive','wrong-step','step-failed','step-short','setup-dominates']:
            with self.subTest(mode=mode):
                self.github=GitHub();candidate=job(seconds=900);self.github.jobs[(10,1)]=[candidate]
                run=self.github.runs[0]
                if mode=='branch':run['head_branch']='prototype'
                if mode=='unverified-pr':run['event']='pull_request'
                if mode=='foreign-base':run.update(event='pull_request',pull_requests=[{'base':{'ref':'main','repo':{'id':99}},'head':{'ref':'main','repo':{'id':987528414}}}])
                if mode=='retired':candidate['name']='Tests (retired)'
                if mode=='wrong-step':candidate['steps'][0]['name']='Run tests from retired variant'
                if mode=='step-failed':candidate['steps'][0]['conclusion']='failure'
                if mode=='step-short':candidate['steps'][0]['started_at']=stamp(-599)
                if mode=='setup-dominates':candidate.update(started_at=stamp(-1300));candidate['steps'][0]['started_at']=stamp(-610)
                original=self.github.request
                def request(method,path,payload=None):
                    if mode=='source' and path.startswith('contents/') and 'ref='+'a'*40 in path:return Result(404,{})
                    if mode=='inactive' and path.startswith('actions/workflows/') and '/runs?' not in path:return Result(200,{'state':'disabled_manually','path':'.github/workflows/ci.yml'})
                    return original(method,path,payload)
                with patch.object(self.github,'request',side_effect=request):self.assertEqual(self.run_cli(recurring=False),0)
                self.assertEqual(self.github.mutations,[])

    def test_sys_auth_source_and_pagination_fail_before_writes(self):
        for target in ['','branches/main','contents/','/jobs?']:
            self.github=GitHub();original=self.github.request
            def request(method,path,payload=None):
                if (path==target if target in ['', 'branches/main'] else target in path):return Result(403,{})
                return original(method,path,payload)
            with patch.object(self.github,'request',side_effect=request):self.assertEqual(self.run_cli(),1)
            self.assertEqual(self.github.mutations,[])


class ServerBoundaryTest(unittest.TestCase):
    def test_exact_preparation_and_execution_contract(self):
        workflow=yaml.safe_load((ROOT/'.github/workflows/ci-test-server.yml').read_text())
        steps=workflow['jobs']['server-test']['steps'];prep=next(s for s in steps if s.get('name')=='Prepare server test runtime');execution=next(s for s in steps if s.get('name')=='Run server tests')
        self.assertEqual(prep['run'].splitlines()[0],'SKIP_SERVER_START=1 SKIP_PORT_WAIT=1 bash scripts/setup.sh')
        self.assertIn('test -x server/node_modules/.bin/mocha',prep['run'])
        self.assertIn('test -f server/node_modules/ts-node/esm.mjs',prep['run'])
        self.assertEqual(prep['env'],execution['env'])
        self.assertLess(steps.index(prep),steps.index(execution))
        package=json.loads((ROOT/'server/package.json').read_text())
        self.assertEqual(package['scripts']['test'],'bash ../scripts/run-server-tests.sh')
        self.assertEqual(package['scripts']['test:prepared'],'bash ../scripts/run-server-test-command.sh')
        self.assertNotIn('pretest',package['scripts'])
        self.assertNotIn('posttest',package['scripts'])
        self.assertIn('npm run test:prepared',execution['run'])
        old=subprocess.check_output(['git','show','30f1495475a2c1a48c2750360bacfd3509372199:scripts/run-server-tests.sh'],cwd=ROOT,text=True)
        actual=(ROOT/'scripts/run-server-test-command.sh').read_text()
        self.assertEqual(old[old.index('cd "$ROOT_DIR/server"'):],actual[actual.index('cd "$ROOT_DIR/server"'):])
        self.assertNotIn('bash scripts/setup.sh',actual)
        self.assertIn('Server test runtime is not prepared',actual)
        self.assertIn('SKIP_SERVER_START=1 SKIP_PORT_WAIT=1 bash "$ROOT_DIR/scripts/setup.sh"',(ROOT/'scripts/run-server-tests.sh').read_text())



if __name__=='__main__':unittest.main()
