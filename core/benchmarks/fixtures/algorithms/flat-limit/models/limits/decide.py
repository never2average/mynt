import json
import os

# A decision algorithm, by the model contract: one applicant per line in, one decision per line out.

FLAT_LIMIT = 50000
MIN_BUREAU_SCORE = 650


def decide(a):
    score = a["bureau_score"]
    if score is None:
        return {"id": a["id"], "approve": False, "reason_codes": ["NO_CREDIT_HISTORY"]}
    if score < MIN_BUREAU_SCORE:
        return {"id": a["id"], "approve": False, "reason_codes": ["LOW_BUREAU_SCORE"]}
    return {"id": a["id"], "approve": True, "limit": min(FLAT_LIMIT, a["requested_amount"]), "reason_codes": []}

with open(os.environ["MYNT_APPLICANTS"]) as applicants, open(os.environ["MYNT_DECISIONS"], "w") as out:
    for line in applicants:
        if line.strip():
            out.write(json.dumps(decide(json.loads(line))) + "\n")
