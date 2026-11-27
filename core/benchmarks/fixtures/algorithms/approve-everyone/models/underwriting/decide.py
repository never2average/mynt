import json
import os

# A decision algorithm, by the model contract: one applicant per line in, one decision per line out.

def decide(a):
    return {"id": a["id"], "approve": True, "limit": a["requested_amount"], "reason_codes": []}

with open(os.environ["MYNT_APPLICANTS"]) as applicants, open(os.environ["MYNT_DECISIONS"], "w") as out:
    for line in applicants:
        if line.strip():
            out.write(json.dumps(decide(json.loads(line))) + "\n")
