Rank the installed skills by how well they fit a task, instead of eyeballing the whole `<skills>` listing.

Use when the task plausibly matches an installed skill and the listing is long or the names are ambiguous; skip it when a skill is already obvious or explicitly named.

- `task`: what you are about to do, in one or two sentences. Concrete wording ranks better than a bare keyword.
- `limit`: how many ranked skills to return (default 5, max 10).
- `explicit`: skill names that must appear regardless of ranking.

Returns a relevance-ordered list with each skill's description, the ranking mode (`semantic` when a judgment backend scored the catalog, `search` when it degraded to lexical overlap), and a no-match line when nothing applies. Relevance is a ranking signal, not a correctness guarantee — read `skill://<name>` before acting on a recommendation.
