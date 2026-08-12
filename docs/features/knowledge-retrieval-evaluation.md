# Knowledge retrieval evaluation

GoodBuddy's retrieval evaluation is an offline Vitest suite that exercises the
real `KnowledgeService` and `KnowledgeDatabase` retrieval path without changing
production data. Run it with:

```text
npm run eval:retrieval
```

By default the suite returns the report only to its tests and leaves no file.
To retain a JSON report, set `GOODBUDDY_RETRIEVAL_EVAL_OUTPUT` to a
workspace-relative file path. Absolute paths and paths escaping the workspace
are rejected.

## Corpus and labels

The committed `synthetic-bilingual-v1` fixture is wholly synthetic, bilingual
(Simplified Chinese and English), and CC0. Stable document, chunk, and query IDs
make changes reviewable. The strict Zod schema bounds every field and rejects
unknown fields, duplicate or dangling IDs, inexact annotations, and
path/endpoint/secret-like values. It also rejects degenerate label sets: each
language must contain both an answerable and a no-answer query.

Each answerable query has graded chunk judgments:

- `3`: directly answers the question.
- `2`: substantially answers it.
- `1`: useful supporting evidence.

Every judgment also contains one or more exact, verbatim answer spans from its
chunk. A no-answer query has no judgments. When adding labels, two reviewers
should independently check relevance grades and exact spans, resolve
disagreements, then update the fixture version or ID when the corpus meaning
changes.

## Evaluation design

Each run creates a temporary SQLite database and directly seeds the production
knowledge classes with stable IDs. It uses deterministic in-memory embedding
providers with stable fingerprints; it does not read API keys, environment
provider settings, user databases, or network resources. Five ablations use
the same corpus:

1. lexical retrieval only;
2. topic-agnostic deterministic token-hash vector retrieval;
3. handcrafted-alias vector retrieval;
4. lexical/vector hybrid retrieval;
5. hybrid retrieval with the local heuristic reranker.

The token-hash provider hashes normalized input tokens without topic-specific
knowledge, so it is a transparent lexical-overlap vector ablation. The
handcrafted bilingual alias provider exists only as **regression plumbing** to
exercise vector, hybrid, and rerank production paths with stable cross-language
matches. It is fixture-aware and is not an embedding-quality model or a claim
about real provider quality.

The suite runs twice and compares the deterministic projection (IDs, hashes,
rank metrics, and failures). Wall-clock latency is intentionally excluded from
that equality check.

## Metrics

- **Recall@5 / Recall@10:** fraction of all annotated relevant chunks returned
  within the cutoff, macro-averaged over answerable queries.
- **MRR@10:** reciprocal rank of the first relevant chunk, with zero when none
  appears in the first ten.
- **Graded nDCG@10:** discounted cumulative gain using `2^grade - 1`, divided
  by the ideal graded ordering.
- **Context precision:** characters in exact annotated spans found in returned
  context divided by all returned context characters.
- **Context recall:** characters in exact annotated spans found in returned
  context divided by all annotated span characters.
- **No-answer false-positive rate:** no-answer queries that return any result
  divided by all no-answer queries.
- **Latency:** count, minimum, median, p95, maximum, and arithmetic mean in
  milliseconds for each ablation. These are diagnostic, not deterministic
  gates.

Rankings are deduplicated by chunk ID before cutoffs and ranking metrics are
computed. Overlapping or nested exact evidence spans are unioned, so duplicate
rank entries and overlapping annotations cannot inflate context precision or
recall. Aggregate metrics are also emitted per language.

## Privacy

Reports contain only fixture/query/ablation IDs, a SHA-256 corpus hash, an
evaluation-definition hash, a hash of provider definitions, aggregate metrics,
latency summaries, and ID-based actionable failures. The
`evaluationDefinitionHash` covers fixture version/ID, raw queries, judgments,
retrieval settings, ablations, provider definitions, and metric version; it
changes when the evaluated contract changes without disclosing that contract.
Reports omit raw queries, document titles, corpus text, snippets/context,
source paths, endpoints, fingerprints, model names, credentials, metadata, and
vectors. The integration test checks every fixture title, chunk, query, and
private provider identifier against the serialized report.

Retained report paths must be workspace-relative. Resolution uses async
filesystem APIs, rejects absolute/traversal paths and null bytes, checks each
parent component, and refuses symlink traversal or a symlink destination. The
report is first written to a same-directory temporary file and then renamed.

## Quality gates

The integration test gates stable lexical, topic-agnostic token-hash,
regression-vector, hybrid, context-precision/context-recall, and per-language
baselines. It also requires reranked MRR@10 of at least 0.78, reranked nDCG@10
of at least 0.75, no-answer false positives no higher than 0.34, and prevents
local reranking from reducing hybrid nDCG@10 by more than 0.05. Exact nDCG
arithmetic has a focused unit test. Gates are fixture baselines rather than
universal production-SLA claims; adjust them only with a reviewed fixture or
justified retrieval behavior change.
