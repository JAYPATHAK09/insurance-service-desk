"""Check report identity, schema and literal evidence against the source case."""
import json
import sys
from pathlib import Path

def verify(case, report, agent, states):
    if report.get('case_id') != case['case_id'] or report.get('agent') != agent:
        raise ValueError('Case or reviewer mismatch')
    if not isinstance(report.get('handoff'), str) or not report['handoff'].strip():
        raise ValueError('Missing handoff')
    findings = report.get('findings')
    if not isinstance(findings, list) or not findings:
        raise ValueError('Missing findings')
    for item in findings:
        for key in ('field', 'status', 'a_quote', 'b_quote', 'action'):
            if not isinstance(item.get(key), str):
                raise ValueError('Invalid field: ' + key)
        if not item['field'].strip() or not item['action'].strip() or item['status'] not in states[agent]:
            raise ValueError('Invalid finding or status')
        if not (item['a_quote'].strip() or item['b_quote'].strip()):
            raise ValueError('No evidence')
        for side in ('a', 'b'):
            if item[side + '_quote'] not in case['source_' + side]:
                raise ValueError('Quote missing from source ' + side)

if __name__ == '__main__':
    case_path, report_path, agent = sys.argv[1:]
    load = lambda path: json.loads(Path(path).read_text())
    verify(load(case_path), load(report_path), agent, load(Path(__file__).with_name('states.json')))
    print('Passed identity, status and literal evidence checks. Human review required.')
