"""Upload Rowflow Sonnet5-V3 16-case human-checked evaluation to existing Opik dataset.

Put this script and sonnet5_v3_opik.json in evaluation/opik/.
Run only once with --upload after verifying --check. Re-running --upload
will stop if an experiment named Sonnet5-V3 already exists.
"""
import argparse
import json
import os
from pathlib import Path

BUNDLE = Path(__file__).with_name('sonnet5_v3_opik.json')


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--upload', action='store_true')
    args = parser.parse_args()

    bundle = json.loads(BUNDLE.read_text(encoding='utf-8'))
    name, rows = next(iter(bundle['experiments'].items()))
    assert name == 'Sonnet5-V3' and len(rows) == 16
    assert len({r['case_id'] for r in rows}) == 16
    expected = {f'E{i:02d}' for i in range(1, 9)} | {f'R{i:02d}' for i in range(1, 9)}
    assert {r['case_id'] for r in rows} == expected
    assert sum(len(r['scores']) for r in rows) == 56
    assert all(v in (0, 1) for r in rows for v in r['scores'].values())

    if not (os.getenv('OPIK_API_KEY') and os.getenv('OPIK_WORKSPACE')):
        raise SystemExit('OPIK_API_KEY and OPIK_WORKSPACE need to be set (do not share the key).')
    from opik import Opik
    project, dataset_name = bundle['project_name'], bundle['dataset_name']
    client = Opik(project_name=project)
    dataset = client.get_or_create_dataset(name=dataset_name, project_name=project)
    remote = dataset.get_items()
    if not isinstance(remote, list):
        remote = list(remote)
    by_case = {}
    for item in remote:
        cid = item.get('case_id')
        if not cid or cid in by_case:
            raise SystemExit('Missing or duplicate case_id in Opik dataset')
        by_case[cid] = item['id']
    if len(remote) != 40 or not expected.issubset(by_case):
        raise SystemExit('Remote dataset mismatch: expected 40 original items containing E01-E08 and R01-R08')
    print(f'Dataset verified: {len(remote)} cases, project={project}')
    print(f'New experiment: {name}, {len(rows)} cases, 56 criteria, '
          f"{bundle['summary'][name]['passed']}/56 passed")
    if args.check:
        print('Check complete. Nothing uploaded.')
        return

    existing = client.rest_client.experiments.find_experiments(name=None, page=1, size=1000)
    known = {getattr(e, 'name', None) for e in (getattr(existing, 'content', None) or [])}
    if name in known:
        raise SystemExit(f'Experiment {name} already exists. Stopped to prevent duplicate upload.')
    payload = []
    for row in rows:
        feedback = [
            {'name': k, 'value': float(v), 'source': 'sdk',
             'reason': 'Human-reviewed Sonnet 5 prompt V3 evaluation; Pass=1, Fail=0'}
            for k, v in row['scores'].items()
        ]
        payload.append({'dataset_item_id': by_case[row['case_id']],
                        'evaluate_task_result': row['output'],
                        'feedback_scores': feedback})
    client.rest_client.experiments.experiment_items_bulk(
        experiment_name=name, dataset_name=dataset_name,
        project_name=project, items=payload)
    print(f'Uploaded {name}: 16 cases. Verify in Opik.')


if __name__ == '__main__':
    main()
