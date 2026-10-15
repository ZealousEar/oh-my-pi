# Fork research decisions — 2026-09-17

Status: owner decisions recorded from the discussion. The owner subsequently approved publishing the public comment below to PR #2 and requested an Astra xhigh assessment of 12-Factor Agents and Jev. The approved comment is published and its full body was read back and matched exactly. This does not authorise runtime implementation, raw-log transmission, activation of experiments, or messages to the other chats.

## Purpose and long-term vision

Build a configurable OMP/pi fork with a quality-first default and explicitly labelled economy/latency presets. Seek higher-quality outcomes through understanding the relationships among provider inference, models, the harness and human intent. Reduce unnecessary token/context use without assuming that fewer tokens necessarily improve quality.

The future observability vision includes retrospective exploration across properly segmented sessions, request-level usage attribution, recorded model inputs and outputs, and the execution history that produced them. This is a vision, not a prerequisite to the first experiment. Recorded execution history cannot reveal unexposed model reasoning or hidden provider implementation.

Self-improvement may propose and evaluate skills, agent instructions and code changes within approved boundaries. It must not redefine human intent or its own governance rules.

## Accepted decisions

### Human authority

- Pause for material mismatches affecting scope, cost, reversibility or intended outcome; otherwise advise and proceed.
- Explain concrete overengineering risks and offer a smaller adequate alternative. Respect the owner's decision once resolved.
- Governance stays human-controlled. Consent, privacy, spending, evaluation and pushback rules may be the subject of proposals, but autonomous self-improvement cannot activate changes to them.

### Patch development and promotion

- Maintain a minimal, separable patch series on a pinned upstream release.
- Integrate and evaluate the patches before considering a subsequent upstream update. Do not automatically rebase or move experimental baselines.
- Require controlled evaluation, then an explicitly approved opt-in real-work trial, then approval for default promotion. Match evidence requirements to the change's risks.
- Approve each behavioural patch's real-work trial separately. Declare tightly coupled patches as one intervention where necessary; obtain separate approval for combined-fork trials.
- Autonomous experiments require an approved research scope, data-access boundary and spending limit. Approval to experiment does not authorise real-work activation, default promotion or publication.
- Preserve quality in the default through prospectively defined evaluation gates. Optional economy/latency presets may accept bounded, measured quality trade-offs. All supported presets retain critical correctness, safety and evidence-integrity requirements.
- The existing experiment's five-percentage-point pilot allowance is not automatic approval for default promotion. Numerical default-promotion thresholds remain to be defined in a protocol.

### Initial research sequence

- Establish a bounded historical baseline before running the controlled model-policy experiment.
- Start with the recent four weeks, expand into older history, and collect prospective sessions alongside both.
- Record harness/model/configuration differences rather than pooling incompatible observations.
- Add only instrumentation necessary for trustworthy measurement in the first cycle; defer the general observability product.
- Use historical logs to identify workloads, failures and hypotheses. Use controlled comparisons for causal claims about patches. Separate observations, inferences and unknown quantities.
- Reserve held-out evidence. Do not use the same examples both to optimise candidates and to claim independent validation.

### Accounting and evaluation

- The user objective is the accounting unit. Link objectives to work episodes, agents/sessions, logical model requests and provider attempts.
- Include child work, retries, failures, compaction, judging and repair. A new session or successor does not reset the objective's accounting boundary.
- A session may contain multiple objectives; one objective may span multiple sessions. Version historical segmentation, label inferred links with uncertainty, and leave ambiguous cases unresolved.
- Shared expenditure requires an explicit allocation rule or remains unallocated; never silently double-count it.
- Combine objective verification and owner assessment of a bounded sample. Model judges provide supporting evidence, not the sole ground truth.
- Distinguish fulfilling the articulated request from serving the intended outcome. Missing feedback is unknown, not success.
- Keep tokens, nominal API-price equivalents, actual paid costs and subscription quota separate. Missing usage is unknown, not zero.
- Evaluate individual interventions and the combined fork. Do not add estimated individual savings together.

### Privacy, retention and publication

- Store detailed traces in a separate private remote evidence store. The specific backend remains undecided.
- Retain traces indefinitely until the owner explicitly authorises deletion. This does not authorise deleting existing local logs.
- Exclude known credentials, including authentication headers, API keys and session cookies. Record redactions that limit reconstruction.
- Start with local content analysis. External model-assisted analysis requires an approved, bounded and sanitised sample. Opening raw logs in a hosted-model session counts as external exposure.
- Remote storage permission and external inference permission are separate boundaries. No destination or upload has yet been approved.
- Use the fork's GitHub repository for patch PRs, hypotheses, protocols, sanitised results and adoption decisions, including relevant negative and inconclusive findings.
- Show the exact target and proposed text and obtain confirmation before posting a GitHub comment or creating an issue.

## Private operational decisions — do not copy into public comments without approval

- Target the retained one Claude 20× account and one ChatGPT 20× account. The two Claude accounts described as being with Fable expire in October and will not be renewed.
- Use expiring accounts for development and preliminary checks where routes permit. Keep their provenance separate; they do not establish future subscription capacity.
- Normal work continues. Do not reserve exclusive account windows. Mark quota attribution unavailable where activity overlaps or telemetry cannot support attribution.
- The reported OpenRouter balance was $7.42. The agreed initial calibration ceiling is $3 total, not per run. No automatic top-ups or paid fallback through other providers. The full experiment requires separate spending approval after calibration.
- No experimental inference has been started under these decisions.

## Current evidence and unresolved execution prerequisites

Read-only inspection found the following public records:

- https://github.com/ZealousEar/oh-my-pi/issues/1 — subagent model-selection investigation.
- https://github.com/ZealousEar/oh-my-pi/pull/2 — token-economics investigation and proposed changes.

PR #2 reports an existing historical analysis pipeline and 21 CSVs, a source baseline at 18.2.4 (`dbf3afad48`), a model-presets branch whose TUI overlay still needs porting, and an upstream OAuth cache-TTL fix already present from 18.1.18. These are report claims, not independently validated implementation or measurement findings in this discussion.

The benchmark handoff read in the experiment pane reports a source base of `dbf3afad4894bde827d90f965e77b3fe1c5a95e5` (18.2.4), four strategies, 27 tasks and two repeats. It reports local validation, but no live results. The named benchmark and investigation directories were absent from the current checkout before this record was created; locate their actual branch or handoff before planning edits.

Before execution:

1. Inventory actual patches, their branches/revisions, the benchmark implementation, existing analysis scripts, available logs and telemetry.
2. Distinguish already-applied settings, compatibility repairs, upstream-superseded changes and unimplemented behavioural proposals.
3. Reuse and audit the existing analysis pipeline before building another; extend the recent-history window and validate accounting/segmentation assumptions.
4. Define the baseline protocol, quality criteria, sampling and held-out evidence.
5. Propose the evidence-store access controls, encryption, credential exclusion and storage costs before uploading data.
6. Obtain approval for the sanitised external-analysis sample and a concrete calibration plan with enforceable spending limits.
7. Resolve benchmark preflight and accounting gaps, then present the full measured-run proposal.

No existing approval authorises replacing the daily installation, merging the patch programme, adopting new presets, publishing raw traces, or contacting the other chats.

## Published public comment

Published to https://github.com/ZealousEar/oh-my-pi/pull/2#issuecomment-5721446197 on 2026-09-17. GitHub comment ID `5721446197`; exact body verified through the API.

### Research and fork decision record — 2026-09-17

The agreed direction is a quality-first, configurable OMP/pi fork with a minimal patch series on a pinned upstream release. We will integrate and evaluate those patches before considering subsequent upstream updates.

We will start with a recent four-week historical baseline, extend into older history, and collect prospective sessions alongside both. Reuse and audit the existing analysis pipeline before adding instrumentation. Historical logs will nominate hypotheses and representative workloads; controlled comparisons and held-out evaluation will support adoption decisions.

The user objective is the accounting unit across sessions, children, retries and repairs. Missing usage and missing feedback remain unknown. Tokens, paid costs, nominal API-price equivalents and subscription quota remain separate. Shared-account activity prevents experiment-specific quota attribution where it cannot be isolated.

Behavioural patches require controlled evaluation, an individually approved real-work trial, and approval before default promotion. Evaluate the combined fork separately. Optional economy/latency presets may make explicit, measured trade-offs; the default remains quality-first. The pilot's five-percentage-point allowance does not automatically qualify a default change.

Detailed traces will remain in a separate private evidence store with owner-controlled deletion. Exclude known credentials. External model-assisted analysis requires approval of a bounded, sanitised sample. Public GitHub records should include protocols, patch provenance, sanitised findings, limitations and adoption/rejection decisions.

The longer-term vision is request-level observability and evidence-backed improvement of skills, agents and harness behaviour. It does not block the first experiment. Autonomous experimentation stays within approved scope, data and spending boundaries; governance and promotion remain human-controlled.

Next, inventory the actual config/preset patches, source baseline, analysis pipeline and benchmark handoff. Distinguish compatibility repairs and upstream-superseded changes from behavioural experiments. Run the model-policy study tracked in #1 only after baseline review, preflight and approval of its measurement and spending protocol. This record does not authorise production changes or claim measured savings.
