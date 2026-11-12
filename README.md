# Indaga Next Check

*Research prototype on made-up cases. Not for patient care, and not clinically validated.*

One next check, for a clinician to review. Pick a made-up rare-disease case:

1. **Fixed rules check for urgency first.** They run on the page, before any AI step. If the person may be acutely unwell, the case goes to a person and no AI is asked.
2. **Otherwise an AI reads the case inside verified hardware.** It reads only the numbered facts, inside NEAR AI Cloud's TEE, and returns a brief:
   - the leading explanation, or none;
   - the gaps in the evidence;
   - exactly one next check.

   Every point cites the facts by number.
3. **The page checks everything.** It verifies the hardware report before sending anything, encrypts the facts to the attested model key, then checks the brief and the reply's signature.

The attestation, encryption and signature code comes from **DNA Confidential**, Indaga's NEAR HACKATHON entry (`private-dna-reading` at commit e5726b69942f0825e590101e20f29f4f337d434a), and is reused unchanged. The relay is DNA Confidential's with payments removed. The model is the same attested `z-ai/glm-5.3-flash`. DNA Confidential itself is not changed by this prototype.

## Run it

You need Node 20.19 or later.

| Do | See |
|---|---|
| `npm install` | 5 runtime packages, the same pinned versions as DNA Confidential |
| `npm test` | 50 tests pass. They cover the urgency rules against NEWS2's published bands, the brief checks (including the misstated brief from a real run), the cases, NEAR's encryption test vector, saved hardware reports with tampered copies, and a full encrypted exchange through the relay |
| `npm run brief -- --case D` | The urgent case stops at the rules. Nothing is sent, and no key is needed |
| `npm start`, then open http://localhost:8788 | The page in **stand-in mode**: the hardware check runs live, and a local stand-in answers, labelled as unattested |
| `NEARAI_API_KEY=… npm start` | The page with the attested model |
| `NEARAI_API_KEY=… npm run brief -- --case A,B,C,D --json checks/run.json` | The whole flow from the command line, with each check printed and a record saved |
| `NEARAI_API_KEY=… npm run brief -- --case D --no-gate` | **For comparison only.** It sends the urgent case to the model without the rules, to see what the model alone says |
| `npm run verify-tee` | A fresh hardware report for the model, checked from this computer |

## The four made-up cases

Every person, date, letter and result is invented. Cases A, B and C reuse the fictional vignettes from Indaga's 12 Nov 2026 four-case model test (P03, P02 and P05), with a source added to each fact. Case D was written for this prototype. The published case from that test (P07) is not used.

| Case | Shows | Urgency rules | The brief's next check in both 12 Nov runs |
|---|---|---|---|
| A. A 5-year-old whose first test left a gap | A well-supported lead | Clear: his paediatrician confirmed he is not acutely unwell | DMD sequencing for small variants, which the copy-number test could not see |
| B. A 39-year-old with two variants and no phase | A lead with one decisive gap | Clear: NEWS2 0 from a complete set of observations | GAA enzyme activity, plus phase from the parents' samples |
| C. A 9-year-old who tires during sports | Too little evidence for a lead | Clear: the intake nurse confirmed the child is otherwise well | No lead. A history and examination before any genetic test |
| D. A 23-year-old, confused after a long run | An urgent presentation | **Stop**: NEWS2 15 with four red scores, and a result the lab flagged as critical | None. The case goes to the treating team, and no AI is asked |

## What the checks showed on 12 Nov 2026

The runs are saved in [`checks/`](checks/).

- **Hardware.** Every attestation check passed for `z-ai/glm-5.3-flash`, in every run:
  - Intel's signature over the TDX quote;
  - the model key and our nonce inside it;
  - the measured software, the boot log and the deployment log;
  - NVIDIA's verdict on the GPUs;
  - NEAR's gateway running in a TEE.
- **Cases A, B and C, in three runs.** The facts were encrypted (E2EE v3), with about 5.5 kB of ciphertext per request.
  - Each brief came back in 5 to 10 seconds in the first two runs, and in up to 45 seconds in the third. Each used about 850 tokens.
  - The third run, at 19:00 UTC, came after the class check was added. It ran all four cases plus case B five more times: no brief misstated a class, and every one passed with a verified signature.
  - Each passed all four brief checks, raised no flag, and took the path its case shows.
  - Each reply's signature verified against the attested key, over the exact request and reply bytes.
- **Case D.** The rules stopped it, and nothing was sent.
- **Case D without the rules (comparison only).** Sent once without the rules, the model also proposed a handover to the treating team. That comes from rule 5 of its instructions, a second line of defence. The page does not rely on it: the fixed rules come first.
- **In the browser.** Cases A and C ran end to end on the page with the attested model:
  - the hardware check passed;
  - the brief passed its checks;
  - the signature verified.

  Case D stopped at step 3. At phone width (375 px, checked in dark mode) the page has no horizontal scroll.

**The miss the class check closes.** In the second run (18:49 UTC), case B's lead called one of the two variants "likely pathogenic". Fact 3 says both are pathogenic. Every citation was valid, so every check passed. Now a brief fails if it states a variant class that no fact gives.
- Re-checked offline, the class check fails exactly that brief and passes the other six saved briefs. The misstated brief is now a test fixture.
- The check compares class words only. It cannot tell which variant a class belongs to, and another misstated fact, such as a count or a value, still needs the clinician.

These checks cover how the brief is produced and whether each point traces to a fact. **They do not show that the advice is right.** The model test behind the cases is exploratory, with 4 cases, provisional author scores and no specialist review. Showing that the brief helps a clinician choose a safe, useful next check needs a study with clinicians against a protocol they agree.

## How it works

```
the page (browser)                        the relay                 NEAR AI Cloud
──────────────────                        ─────────                 ─────────────
numbered facts, each with a source
urgency rules: NEWS2 (adults), the
lab's critical flags, a clinician's
confirmation; urgent or not ruled out
→ a person, nothing sent
        │ 1. fresh nonce ────────────────────────────────────▶ hardware report
        │◀────────────────────────────────────────────────── (TDX quote, GPU evidence)
checks Intel's chain, the key and the
nonce, the software, NVIDIA's verdict
        │ 2. facts encrypted to the attested key ──▶ checks the fixed shape,
        │                                            adds the API key ──▶ model in the TEE
        │◀──────────── brief encrypted to this page's key ◀──────────── writes the JSON brief
decrypts; checks the brief: one next
check, citations, confidence, flags
        │ 3. signature lookup ────────────▶ ─────────────────▶ signed hash of request + reply
checks the Ed25519 signature against
the attested key
```

- [`src/cases/cases.mjs`](src/cases/cases.mjs) holds the made-up cases. Only the facts are sent. The title, the path a case shows and the setting stay on the page.
- [`src/triage/urgency.mjs`](src/triage/urgency.mjs) holds the urgency rules. The AI never judges urgency. Their order:
  1. **A critical lab result.** A result the lab itself flagged as critical stops the case.
  2. **NEWS2, for adults (16 or over).** The [Royal College of Physicians' NEWS2](https://www.rcp.ac.uk/resources/national-early-warning-score-news-2/) (2017) scores the observations, with the chart 1 bands on SpO2 scale 1. A 3 in any parameter, or a total of 5 or more, stops the case (chart 2: the red score and the key threshold for an urgent response).
  3. **Going on.** A case goes on only if a complete NEWS2 set scores low, or a named clinician confirmed that the person is not acutely unwell. Otherwise it is held for a person.
- [`src/ai/prompt.mjs`](src/ai/prompt.mjs) holds the model's fixed instructions and the request's fixed shape. The relay checks that shape. It cannot read the content.
- [`src/ai/brief.mjs`](src/ai/brief.mjs) parses the reply and checks it:
  - one JSON brief;
  - exactly one next check, typed (test, evidence or handover), with why and what it cannot show;
  - one to three gaps;
  - every point citing this case's fact numbers;
  - a lead, if any, with a confidence of low, moderate or high;
  - no variant class that the facts do not give. "Likely pathogenic" is not "pathogenic"; VUS means uncertain significance; a negated or hypothetical mention ("sequencing may find a pathogenic variant") does not count.

  It raises four flags:
  - wording about a dose or a treatment step;
  - a diagnosis presented as settled;
  - a test proposed with no lead;
  - a handover the rules did not call for.

  The flags are word patterns, not guarantees.
- [`src/tee/`](src/tee/) and [`src/util/`](src/util/) are DNA Confidential's attestation, encryption (NEAR AI E2EE v3) and signature modules, unchanged. Their tests and fixtures are copied with them.

## What this does not show

- **That the advice is right.** The clinician decides. The checks only make each point traceable to the facts and the limits explicit.
- **That the urgency rules are complete.** They check what they read and nothing else:
  - NEWS2 is for adults, reads observations rather than blood results, and is used here without SpO2 scale 2 and not in pregnancy;
  - a child goes on only with a clinician's confirmation.
- **Anything about real patients.** Real use would need clinical governance, consent, and a reviewed data path with an agreed data processor.
- **The hardware makers and the model's software.** The attestation proves which hardware and measured software hold the key. It trusts Intel's and NVIDIA's keys, and it does not prove that the software has no bugs or keeps no logs.

## Status

Local prototype, 12 Nov 2026. It is not deployed and has no remote.

Licence: MIT for the code (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Built by [Indaga](https://indaga.ai), an AI-native company building personalized medicine.
