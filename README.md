# Indaga Next Check

*Research prototype on invented cases. Not for patient care, and not clinically validated.*

Next Check is for a clinician working up a suspected rare disease. It returns a short brief: one next check, with every point citing the case's facts by number. It works on four invented cases.

1. **Urgency rules come first.** They are fixed, published rules that run on the page before any AI step: NEWS2 for adults, and the lab's own critical flags. If the person may be acutely unwell, the case goes to the treating team and nothing is sent to the AI.
2. **Otherwise a model reads the case inside verified hardware.** The model runs on NEAR AI Cloud, inside a TEE: an Intel TDX confidential VM with NVIDIA GPUs in confidential-computing mode.
   - The browser checks the hardware report first.
   - It then encrypts the numbered facts to the model's attested key. Our server and NEAR's gateway see only ciphertext.
3. **The page checks the reply.** The brief holds:
   - the leading explanation, or none;
   - one to three gaps in the evidence;
   - exactly one next check.

   The page checks the brief's form and citations, and checks the model's signature over the exact request and reply. It shows the brief only if every check passes.

Built by [Indaga](https://indaga.ai) at NEAR HACKATHON 2026, on 12–13 Nov. It is a separate project from Indaga's other entry, **[DNA Confidential](https://github.com/indaga-ai/private-dna-reading)**, and reuses that entry's attestation and encryption code (see [Relationship to DNA Confidential](#relationship-to-dna-confidential)).

## The problem

- **Choosing the next check.** A clinician may hold a scattered set of findings:
  - a clinic letter;
  - observations;
  - a gene panel with stated limits.

  They have to choose what should come next: a test, more history and examination first, or a handover because the person is unwell now.
- **Clinical facts are sensitive.** Sending them to an ordinary AI service means trusting whoever runs it. Here, only hardware whose report the page has just checked can decrypt the facts, and anyone can repeat that check.
- **Urgency is not left to the AI.** Fixed rules decide first, and the model never sees a case they stop.

All four cases are invented. The page has no upload and takes no free text.

## Try it

You need Node 20.19 or later. Steps 1 to 5 need no key.

| Do | See |
|---|---|
| 1. `npm install` | 5 runtime packages, listed under [Built with](#built-with) |
| 2. `npm test` | 51 tests pass. They cover:<br>• the urgency rules against NEWS2's published bands;<br>• the brief checks, including a misstated brief from a real run;<br>• the cases;<br>• NEAR AI's encryption test vector;<br>• saved hardware reports and tampered copies of them;<br>• a full encrypted exchange through the relay. |
| 3. `npm run brief -- --case D` | The urgent case stops at the rules, with NEWS2 15, four red scores and a potassium result the lab flagged as critical. Nothing is sent |
| 4. `npm run verify-tee` | A fresh hardware report for the model, fetched with a new nonce and checked on your computer, each check marked PASS or FAIL |
| 5. `npm start`, then open http://localhost:8788 | The page in **stand-in mode**: the hardware check runs live, and a local stand-in answers, labelled as unattested |
| 6. `NEARAI_API_KEY=… npm start`, open http://localhost:8788 and pick **case B** | The page goes through, in order:<br>• the facts, each with its source, and the lab report's classification of each GAA variant;<br>• the urgency rules: NEWS2 0 from a complete set, so the case may go on;<br>• **Check the hardware**: Intel's signature over the TDX quote, the nonce and model key inside it, the measured software, NVIDIA's verdict on the GPUs, and NEAR's gateway;<br>• **Encrypt and send**: the ciphertext our server and NEAR's gateway see, then the brief;<br>• every check on the brief, and the signature verified against the attested key. |
| 7. On the same page, pick **case D** | The rules stop it and say to hand over to the treating team now. **Encrypt and send** stays off |
| 8. `NEARAI_API_KEY=… npm run brief -- --case A,B,C,D --json checks/run.json` | The whole flow in the terminal: each check printed, a record saved, and what NEAR AI's billing charged |

A key comes from [cloud.near.ai](https://cloud.near.ai). On 12 Nov 2026, NEAR AI's billing charged $0.00013 to $0.00017 a brief, for 600 to 720 tokens in and 150 to 250 out.

## What NEAR does here

- **NEAR AI Cloud** serves `z-ai/glm-5.3-flash` inside a TEE.
- **Attestation is checked in the browser** ([`src/tee/attestation.mjs`](src/tee/attestation.mjs)). The page asks NEAR AI Cloud for a hardware report with a fresh nonce, and checks:
  - Intel's signature chain over the TDX quote, with [`@phala/dcap-qvl`](https://www.npmjs.com/package/@phala/dcap-qvl);
  - that the quote binds the nonce and the model's signing key;
  - the measured software: the compose hash, RTMR3's event log and the deployment log;
  - NVIDIA's signed verdict on the GPUs (NRAS);
  - that NEAR's gateway also runs in a TEE.
- **The case is encrypted end to end** ([`src/tee/e2ee.mjs`](src/tee/e2ee.mjs), NEAR AI's E2EE v3: X25519 and XChaCha20-Poly1305).
  - The page encrypts the facts to the attested model key.
  - The reply comes back encrypted to a key the page made for this visit.
- **The reply is signed** ([`src/tee/signature.mjs`](src/tee/signature.mjs)). The model's Ed25519 signature covers hashes of the exact request and reply bytes, and the page checks it against the attested key.

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
the attested key; only then shows the brief
```

- [`src/cases/cases.mjs`](src/cases/cases.mjs) holds the invented cases. Only the facts are sent. The title, the path a case shows and the setting stay on the page.
- [`src/triage/urgency.mjs`](src/triage/urgency.mjs) holds the urgency rules. They run in this order:
  1. **A critical lab result.** A result the lab itself flagged as critical stops the case.
  2. **NEWS2, for adults (16 or over).** The [Royal College of Physicians' NEWS2](https://www.rcp.ac.uk/resources/national-early-warning-score-news-2/) (2017) scores the observations, with the chart 1 bands on SpO2 scale 1. A 3 in any parameter, or a total of 5 or more, stops the case: chart 2's red score and its threshold for an urgent response.
  3. **Going on.** A case goes on only if a complete NEWS2 set scores low, or a named clinician confirmed that the person is not acutely unwell. Otherwise it is held for a person.
- [`src/ai/prompt.mjs`](src/ai/prompt.mjs) holds the model's fixed instructions and the request's fixed shape. The relay checks that shape, but it cannot read the content.
- [`src/ai/brief.mjs`](src/ai/brief.mjs) parses the reply and checks it:
  - one JSON brief;
  - exactly one next check, typed as a test, evidence or a handover, with why it comes next and what it cannot show;
  - one to three gaps;
  - every point citing this case's fact numbers;
  - a lead, if any, with a confidence of low, moderate or high;
  - no variant classification words in the generated text. The page shows each variant's classification from the lab report itself.

  It raises four flags. They are word patterns, not guarantees:
  - wording about a dose or a treatment step;
  - a diagnosis presented as settled;
  - a test proposed with no lead;
  - a handover the rules did not call for.

**Nothing is kept on the server.** The relay ([`server/handler.mjs`](server/handler.mjs), and [`api/relay.mjs`](api/relay.mjs) for the hosted copy) checks each request against the brief's fixed shape and forwards the ciphertext with the API key. It stores no request, no reply and no log of either. It logs only the name of an unexpected error. In memory only, it holds:
- rate-limit counters: a client address and a time, dropped after a day. The limits are 12 briefs an hour and 40 a day per address, and 200 a day per server;
- a ten-minute cache of Intel's public collateral.

## The four invented cases

Every person, date, letter and result is invented. None is a real patient or a published case report.

| Case | Shows | Urgency rules | The brief's next check on 12 Nov |
|---|---|---|---|
| A. A 5-year-old whose first test left a gap | A well-supported lead | Clear: his paediatrician confirmed he is not acutely unwell | DMD sequencing for small variants, which the copy-number test could not see |
| B. A 39-year-old with two GAA variants and no phase | A lead with one decisive gap | Clear: NEWS2 0 from a complete set of observations | GAA enzyme activity, with phase from the parents' samples or long reads |
| C. A 9-year-old who tires during sports | Too little evidence for a lead | Clear: the intake nurse confirmed the child is otherwise well | No lead. A history and examination before any genetic test |
| D. A 23-year-old, confused after a long run | An urgent presentation | **Stop**: NEWS2 15 with four red scores, and a result the lab flagged as critical | None. The case goes to the treating team, and no AI is asked |

## What the checks showed on 12 Nov 2026

The runs are saved in [`checks/`](checks/).
- **Hardware.** Every attestation check passed for `z-ai/glm-5.3-flash` in every run. That covers Intel's signature over the TDX quote, the nonce and model key inside it, the measured software, NVIDIA's verdict, and NEAR's gateway.
- **Cases A, B and C.**
  - Each request carried 5.3 to 6.2 kB of ciphertext.
  - The briefs took the path each case shows, passed every brief check, and had signatures that verified against the attested key over the exact request and reply.
- **Case D.** The rules stopped it, and nothing was sent.
- **Case D without the rules (comparison only, `--no-gate`).** Sent once, the model also proposed a handover. That comes from its instructions, a second line of defence. The page does not rely on it; the fixed rules come first.
- **One miss, and the fix.** In the second run, case B's lead called one of the two GAA variants "likely pathogenic", though the lab report gives both as pathogenic. Every citation was valid, so every check passed.
  - A first fix failed briefs that stated a class no fact gives. It could still pass two genuine labels swapped between the variants.
  - Now the generated text may not use classification words at all, and the page shows each variant's classification straight from the numbered lab-report fact.
  - The misstatement and a swap are regression tests. The [rerun](checks/2026-11-12-source-classifications-run.json) passed A, B and C with verified signatures and stopped D before inference.
- **A known gap.** In that rerun, B's lead still said the variants were "in trans" while noting that phase is unconfirmed. The lab report does not establish phase. No check catches that kind of factual slip: the clinician has to.

These checks cover how the brief is produced and whether each point traces to a fact. **They do not show that the advice is right.** The cases come from an exploratory four-case model test with provisional author scores and no specialist review. Showing that the brief helps a clinician choose a safe, useful next check would need a study with clinicians, against a protocol they agree.

## What this does not show

- **That the advice is right.** The clinician decides. The checks only make each point traceable to the facts, and make the limits explicit.
- **That the urgency rules are complete.** They check what they read and nothing else:
  - NEWS2 is for adults and reads observations, not blood results;
  - it is used here without SpO2 scale 2, and not in pregnancy;
  - a child goes on only with a clinician's confirmation.
- **Anything about real patients.** Real use would need clinical governance, consent, and a reviewed data path with an agreed data processor.
- **That the hardware makers and the model's software can be trusted.** The attestation shows which hardware and measured software hold the key. It relies on Intel's and NVIDIA's keys. It does not show that the software has no bugs or keeps no logs.

## Relationship to DNA Confidential

Next Check and DNA Confidential are two separate projects by the same team, Indaga. Each README names the other, as the NEAR HACKATHON rules ask of one team with two projects (Q-015).

| | [DNA Confidential](https://github.com/indaga-ai/private-dna-reading) | Indaga Next Check |
|---|---|---|
| For | A person, about their own health data | A clinician, about a suspected rare disease |
| Input | The person's DNA file, watch data and blood test, read in their browser | The numbered facts of an invented case |
| Output | A reading that starts with a short plan | One next check, the gaps, and an optional lead |
| Rules before the AI | The plan comes from a fixed table of rules | Urgency: NEWS2 and the lab's critical flags |
| Payment | Any coin, through NEAR Intents | None |
| Built | 7–11 Nov 2026 | 12–13 Nov 2026 |
| Demo | https://private-dna.indaga.ai | `npm start`, as above |

**Reused from DNA Confidential**, under its MIT licence, from commit e5726b69942f0825e590101e20f29f4f337d434a:
- **unchanged:**
  - `src/tee/*` and `src/util/bytes.mjs`;
  - `server/errors.mjs` and `server/ratelimit.mjs`;
  - `scripts/build.mjs`, `scripts/check-bundle.mjs` and `scripts/verify-tee.mjs`;
  - `test/attestation.test.mjs`, `test/e2ee.test.mjs` and their fixtures.
- **adapted:** `server/handler.mjs` and `server/stand-in.mjs`, with payments removed and the brief's request shape added, and the hosted relay (`api/relay.mjs`, `vercel.json`).

**New in Next Check:**
- the urgency rules (`src/triage/`);
- the cases (`src/cases/`);
- the instructions and fixed request shape (`src/ai/prompt.mjs`);
- the brief checks and the lab-report classifications (`src/ai/brief.mjs`);
- the page (`web/`);
- the command-line run (`scripts/brief.mjs`);
- their tests.

## Built with

- **Runtime packages:** `@noble/ciphers`, `@noble/curves` and `@noble/hashes` 2.4.0, `@phala/dcap-qvl` 0.7.0 and `jose` 6.2.13. `esbuild` 0.28.2 builds the page bundle.
- **NEAR AI's [inference-sdk](https://github.com/nearai/inference-sdk)** (MIT) was the protocol reference, and its published Ed25519 test vector is in `test/fixtures/`.
- **NEWS2:** the Royal College of Physicians' [NEWS2](https://www.rcp.ac.uk/resources/national-early-warning-score-news-2/) (2017).
- **AI coding assistants:** the code was written with Claude Code and Codex, directed and reviewed by the team.

## About

Built by [Indaga](https://indaga.ai), an AI-native company building personalized medicine. This is an open-source research prototype, separate from Indaga's own service.

Licence: MIT for the code; see [LICENSE](LICENSE). The Indaga name and logo, the fonts (SIL OFL) and the NEWS2 bands are covered in [NOTICE](NOTICE). Not medical advice.
