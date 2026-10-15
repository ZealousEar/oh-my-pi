# 12-Factor Agents and Jev assessment

Date: 2026-09-17. Status: research and recommendations, not approved implementation or experimental results.

## Verdict

Adopt selected 12-Factor Agents principles as engineering guidance for the existing OMP fork. Evaluate Jev as an optional backend for narrow semantic judgments. Preserve the general-purpose coding loop; keep permissions, budgets, validation, accounting and side effects under deterministic control. Do not start a framework rewrite or add another provider adapter.

The principles fit the owner's quality, transparency and human-control goals. They do not prove that shorter context, more decomposition, or Jev improves the owner's workloads. Measure architecture changes separately from backend changes.

## Completed work and provenance

- Published the approved research charter to [PR #2](https://github.com/ZealousEar/oh-my-pi/pull/2#issuecomment-5721446197). Read back the full body through GitHub's API and verified exact equality with the approved draft. Account details and balances were excluded.
- Ran a separate read-only OMP research process with `--model openai-codex/gpt-6-astra --thinking xhigh`. Assistant events confirmed provider `openai-codex` and model `gpt-6-astra`; process exited 0. Disabled model fallback and advisor in a temporary per-run overlay. An initial non-PTY launch blocked on stdin and was stopped before the successful PTY launch.
- Research session ID: `01a0b144-6dcd-7000-b83a-79b2c02f1433`. Preserved the complete final report in `data/12factor-astra-xhigh-review.txt`.
- The subagent read the README, twelve canonical factors and relevant TypeSafe sources, including the factor 12 figures. The parent independently read all twelve factor documents as text, TypeSafe documentation and selected local judgment implementation files.
- Retrieved Dillon Mulroy's linked post through the public tweet endpoint. Its actual text describes composing AI into systems rather than AI becoming the whole system. The separate longer quotation supplied by the owner has unverified attribution.
- Ran one local, no-network probe of existing judgment parsing/usage helpers. No Jev calls, private-log analysis, benchmark runs, installation updates or behavioural patches occurred.
- The subagent proposed a $25 study with specific panel sizes and thresholds. These are not owner decisions and are not adopted. The existing $3 total OpenRouter calibration ceiling remains; it does not authorise direct TypeSafe spending.

## Source interpretation

[HumanLayer's framework](https://github.com/humanlayer/12-factor-agents) supplies practitioner architecture guidance, not a controlled scientific demonstration of twelve universally beneficial factors. It advocates small agent loops embedded in ordinary software and explicit ownership of prompts, context and control flow.

[TypeSafe's announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev) describes Jev as unstructured state plus typed questions producing distributions/decisions rather than free-form text. The [API documentation](https://docs.typesafe.ai/introduction) defines Choice, Score and Noul primitives. The [function-calling example](https://docs.typesafe.ai/cookbooks/function_calling.md) handles closed-set arguments. Its example leaves unsupported open-ended arguments at defaults; that is unsuitable for silently interpreting arbitrary coding requests.

The [vendor workflow evaluation](https://evals.typesafe.ai/) assumes workflow correctness and uses frontier-model consensus as its reference. It covers four workflows, not general repository development. The announcement acknowledges selection bias, favorable demo inputs, and comparison overhead from probability-producing LLM adapters. Advertised speed/cost multipliers are vendor-produced results, not estimates for this fork.

Use typesafe.ai and docs.typesafe.ai as primary Jev sources. A search hit at jevai.org claimed official status but linked canonical jev.ai to a domain marketplace; it was excluded as authoritative evidence.

## Factor-by-factor decision recommendations

These recommendations have not changed runtime behaviour.

| Factor | Recommendation | Adaptation for the fork |
|---|---|---|
| 1. Natural language to tool calls | Adapt | Interpret into a proposal; separate parameter construction, validation and authority. |
| 2. Own prompts | Adopt | Version templates, questions, criteria, schemas and resolved inputs. |
| 3. Own context | Adapt | Build inspectable request projections while retaining permitted source evidence and trust boundaries. |
| 4. Tools are structured outputs | Adopt | Treat a tool call as proposed data; code decides whether/how to execute. |
| 5. Unify execution/business state | Adapt | Link authoritative events and derive views; keep permissions and budgets outside the model's lossy context. |
| 6. Launch/pause/resume | Adopt | Preserve the approval boundary before invocation; reconcile uncertain external outcomes on resume. |
| 7. Contact humans through tools | Adapt | Record clarification/approval/resolution explicitly; enforce mandatory pauses outside model discretion. |
| 8. Own control flow | Adopt | Code owns budgets, permissions, waiting, cancellation and fallback policy. |
| 9. Compact errors | Adapt | Give useful bounded feedback to the model; retain raw permitted error evidence and attempt costs. |
| 10. Small focused agents | Adapt | Use stable, bounded responsibilities where useful; do not impose a universal turn cap or fragmentation policy. |
| 11. Trigger from anywhere | Defer | New channels add identity and authorization surfaces without serving the immediate experiment. |
| 12. Stateless reducer | Adapt | Reconstruct state from recorded events; record nondeterministic results and side-effect receipts. |

Factor 12's text is brief and diagram-led, not a specification for durable replay. Factor 10's suggested 3–20-step scope is guidance, not evidence for cutting off long coding tasks.

## The useful architecture

Use the following conceptual separation within existing boundaries rather than creating six new services:

1. Interpret the request and identify unresolved ambiguity.
2. Construct a concrete proposed action and its parameters.
3. Validate schema, current resource state and cross-field constraints.
4. Check authorization against owner-controlled scope, data and spending policy.
5. Execute through the existing tool boundary and record results.
6. Verify outcomes and reconcile unknown side effects before retrying.

A classifier can help with interpretation or bounded semantic checks. A generative model still supplies arbitrary code, patches and explanations. Ordinary code should count tokens, compare revisions, inspect exit status and enforce spending. Confidence cannot grant a capability or enlarge a budget.

Keep the general coding loop for tasks whose investigation cannot be predetermined. Decomposition may duplicate context, add round trips, lose cross-file invariants or make locally correct decisions inconsistent with the overall objective. Independent model questions are not statistically independent evidence.

## Observability and replay

The future viewer needs three linked layers:

- Permitted retained evidence: user events, tool results, outputs, decisions and execution receipts.
- Derived context: selected snippets, summaries, compaction results, child reports and their sources.
- Submitted requests: recorded client-side payloads, model route, parameters, schema/config versions and attempt identity.

Record transformations and omissions. Removing material from a request should not erase its source evidence. A content hash alone cannot reconstruct missing content; keep permitted content or a retrievable protected reference and label redactions.

Distinguish:

- Playback of retained requests/results.
- Deterministic state reconstruction using recorded nondeterministic inputs.
- Counterfactual reruns, which make new calls and can change outcomes or incur costs.

Exact recorded client inputs are not proof of every provider-internal input. Hidden provider preprocessing, hidden reasoning and undocumented server state remain unobservable.

A crash after sending an action but before recording its receipt produces an unknown outcome. Thread serialization alone cannot make replay safe; use idempotency or reconciliation before re-executing effects.

## Jev limitations that matter here

The [known limitations for Jev 1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) explicitly identify literal interpretation, numerical weakness, indirection, irrelevant-context degradation and adversarial input susceptibility. Typed outputs can still be semantically wrong. Jev is not an authorization or prompt-injection security boundary.

[Confidence](https://docs.typesafe.ai/confidence.md) summarizes the shape of a returned distribution. It is not automatically a probability that an entire action is correct. Evaluate calibration and selective error rates on the actual workload; do not multiply marginal probabilities as though errors were independent. A score expectation is not an exact numeric extraction.

[Model documentation](https://docs.typesafe.ai/models.md) recommends pinning a version when thresholds depend on it; moving `jev-latest` can change answers. Record both requested and reported model identities.

The [privacy policy](https://typesafe.ai/legal/privacy-policy) promises not to train/fine-tune on input, but describes retention, service providers and US processing. It is not a zero-retention promise. The owner's approved-sample boundary still applies to historical content.

## Existing OMP integration: observed findings

This was a focused source inspection and one deterministic probe, not a full integration/security audit.

### Reuse the existing judgment layer

- `packages/ai/src/judgment/types.ts:80-102` defines typed judgment requests/results, model provenance and usage.
- `packages/ai/src/judgment/typesafe.ts:100-118` already calls `POST /v1/systemone` and returns the reported model and usage.
- `packages/coding-agent/src/judgment/index.ts:91-125` already selects TypeSafe and falls back to an online chat judge.

A new Jev adapter would duplicate current capability.

### Confidence semantics change across backends

`packages/ai/src/judgment/text.ts:230-252` turns parsed text answers into one-hot distributions and `confidence: 1`. This encodes a selected label, not measured calibration. The TypeSafe-to-chat fallback in `packages/coding-agent/src/judgment/index.ts:115-122` can therefore return the same structural interface with different confidence semantics.

The local probe called `parseAnswer` with a two-option choice and the reply `read`. It exited 0 and returned:

```json
{"type":"choice","choice":"read","probabilities":{"read":1,"write":0},"confidence":1}
```

Recommendation: distinguish native distributions from synthetic one-hot label encodings before implementing confidence gates. Treat fallback results as a separately evaluated policy, with explicit provenance and abstention/confirmation rules. This is a prospective integration risk; this review did not establish that an existing action-permission consumer currently misuses confidence.

### Token usage is not a complete monetary ledger

`packages/ai/src/judgment/typesafe.ts:117` uses `tokenUsage`. In `packages/ai/src/judgment/types.ts:118-127`, that helper preserves counts but sets monetary cost fields to zero. The local probe `tokenUsage(1000, 0)` returned 1000 total tokens with all cost fields zero.

Recommendation: treat these as unpriced usage fields, not proof of free inference. Reconcile rate-card estimates and actual charges separately. Audit failed attempts and retries: the shown native transport has retries, but its result interface reports the successful response's usage rather than an explicit attempt ledger. The source review did not establish actual charges for failed calls.

### Pin identity and audit fallback before measuring

The native default is `jev-latest` (`typesafe.ts:28-39`), with a model override already available. The response preserves the resolved model. Use those existing capabilities for a versioned experiment. Do not silently compare a mixed fallback policy as if it were Jev alone.

## Research sequence

1. Reconcile actual config/preset patches, source baseline, historical analyser and benchmark handoff.
2. Audit objective/attempt accounting and context provenance; extend existing utilities instead of creating a competing pipeline.
3. Run the separately approved four-arm model-policy study without introducing new judgment/routing/context policies into it.
4. Propose one separate offline or shadow-mode judgment study. Validate architecture and backend effects separately.
5. Admit successful candidates to individually approved real-work trials, then evaluate the combined fork.

The future viewer and autonomous improvement system should consume validated trace contracts. They are not prerequisites for the first model-policy experiment.

## Suggested later experiment, not an authorised run

Use a narrow advisory question: does a claimed verification result overstate the supplied evidence?

Start with public or clearly labelled synthetic packets containing a claim, task requirement, revision identity and verification receipts. Ordinary code checks exact revision matches, exit statuses and missing receipts. A model evaluates only semantic correspondence and scope. It may flag review or abstain; it does not approve actions or declare a task complete.

Compare:

- D: deterministic checks, abstaining on unresolved semantics.
- A: one holistic judgment using a pinned existing model.
- B: decomposed typed questions and code, using the same model as A.
- C: the same questions and code as B with a pinned Jev backend, only after separate access/spending approval.

B versus A tests architecture. C versus B tests the backend within that architecture. D tests whether a model adds useful coverage at all.

Measure unsupported claims incorrectly cleared, unnecessary review, abstention/coverage, end-to-end quality, calibration where meaningful, p50/p95 latency, all attempts and cost. Group splits and uncertainty by originating objective/case; related mutations and repeated calls are not independent tasks. Include missing evidence, wrong revisions, contradictions and adversarial tool output.

Choose sample size, thresholds and spending only after bounded calibration and owner review. Prefer deterministic code if it meets the need. A good fixed-packet result earns consideration for an advisory real-work trial, not a claim of improved long-horizon coding.

## Recommendations versus decisions

The published charter remains the owner-approved policy. This research recommends architectural fit and specific cautions; it changes neither the charter nor runtime defaults. The preserved Astra report contains proposed experimental numbers that the parent did not adopt. No raw historical data was transmitted and no Jev credentials or paid calls were used in this assessment. New GitHub publication of these findings requires review of the proposed text and target.
