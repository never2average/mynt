import json
import os

# A decision algorithm, by the model contract: one applicant per line in, one decision per line out.

MIN_BUREAU_SCORE = 740
MIN_TENURE_MONTHS = 36


def decide(a):
    reasons = []
    score = a["bureau_score"]
    if score is None:
        reasons.append("NO_CREDIT_HISTORY")
    elif score < MIN_BUREAU_SCORE:
        reasons.append("LOW_BUREAU_SCORE")
    if a["tenure_months"] < MIN_TENURE_MONTHS:
        reasons.append("SHORT_TENURE")
    if reasons:
        return {"id": a["id"], "approve": False, "reason_codes": reasons}
    return {"id": a["id"], "approve": True, "reason_codes": []}

with open(os.environ["MYNT_APPLICANTS"]) as applicants, open(os.environ["MYNT_DECISIONS"], "w") as out:
    for line in applicants:
        if line.strip():
            out.write(json.dumps(decide(json.loads(line))) + "\n")
