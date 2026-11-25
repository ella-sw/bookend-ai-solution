"""Upload function-specific human-graded Rowflow results; NO LLM calls. Uses original experiment names; do not run upload more than once.

Place this script beside rowflow_results_final.json.
PowerShell:
  python -m pip install --upgrade opik
  $env:OPIK_API_KEY = "..."
  $env:OPIK_WORKSPACE = "..."
  python upload_rowflow_opik_final.py --check
  python upload_rowflow_opik_final.py --upload
Do NOT upload twice: repeat can create duplicate experiment items.
"""
import argparse,json,os
from pathlib import Path

BUNDLE=Path(__file__).with_name('rowflow_results_final.json')

def main():
    parser=argparse.ArgumentParser()
    g=parser.add_mutually_exclusive_group(required=True)
    g.add_argument('--check',action='store_true',help='Check remote dataset and local scores; no changes')
    g.add_argument('--upload',action='store_true',help='Upload four existing evaluations, run once')
    args=parser.parse_args()
    bundle=json.loads(BUNDLE.read_text(encoding='utf-8'))
    if not (os.environ.get('OPIK_API_KEY') and os.environ.get('OPIK_WORKSPACE')):
        raise SystemExit('OPIK_API_KEY and OPIK_WORKSPACE must be configured in your terminal (do not send your API key).')
    from opik import Opik
    project=bundle['project_name'];dataset_name=bundle['dataset_name']
    client=Opik(project_name=project)
    dataset=client.get_or_create_dataset(name=dataset_name,project_name=project)
    remote=dataset.get_items()
    if not isinstance(remote,list):remote=list(remote)
    remote_by_case={}
    for item in remote:
        cid=item.get('case_id')
        if not cid:raise SystemExit('The remote dataset has an item without case_id')
        if cid in remote_by_case:raise SystemExit('Duplicate dataset case_id: '+cid)
        remote_by_case[cid]=item['id']
    expected=set(x['case_id'] for x in next(iter(bundle['experiments'].values())))
    if expected!=set(remote_by_case):
        raise SystemExit(f'Dataset mismatch: expected {len(expected)} / remote {len(remote_by_case)}. Missing={sorted(expected-set(remote_by_case))}, extra={sorted(set(remote_by_case)-expected)}')
    print(f'Dataset verified: {len(remote_by_case)} cases, project={project}')
    for n,s in bundle['summary'].items():print(f"{n}: {s['passed']}/{s['scores']} ({s['pass_rate']}%)")
    if args.check:
        print('Check completed; nothing uploaded.')
        return
    # Fail safely if any names already exist, rather than duplicating data.
    existing=client.rest_client.experiments.find_experiments(name=None,page=1,size=1000)
    known={getattr(e,'name',None) for e in (getattr(existing,'content',None) or [])}
    conflicting=known.intersection(bundle['experiments'])
    if conflicting:raise SystemExit('Experiments already exist. Stopping to prevent duplicate uploads: '+', '.join(sorted(conflicting)))
    for n,rows in bundle['experiments'].items():
        payload=[]
        for row in rows:
            feedback=[{'name':k,'value':float(v),'source':'sdk','reason':'Human manual evaluation from original Excel; Pass=1, Fail=0'} for k,v in row['scores'].items()]
            payload.append({'dataset_item_id':remote_by_case[row['case_id']],
                            'evaluate_task_result':row['output'],
                            'feedback_scores':feedback})
        client.rest_client.experiments.experiment_items_bulk(experiment_name=n,
            dataset_name=dataset_name,project_name=project,items=payload)
        print(f'Uploaded {n}: {len(rows)} cases')
    print('Finished. Check Opik Experiments comparison page.')

if __name__=='__main__':main()
