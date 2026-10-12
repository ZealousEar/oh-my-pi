{{#if criterion}}
{{#if yes}}`task.original_request`, `task.latest_request`, `task.latest_reply`, or one of `task.standing_requirements` needs every candidate line: an exact count, enumeration, ordered listing, value from each progress line, machine-readable structure, or complete evidence set.{{else}}The task and the command's evident purpose remain satisfied by retained context plus concise omission markers; no task field needs every routine candidate line.{{/if}}
{{else}}
Goal: Decide whether `task.original_request`, `task.latest_request`, `task.latest_reply`, or any of `task.standing_requirements` needs every line of the output of `{{command}}`.

Success means assigning high probability when the task or command's evident purpose needs a count, an enumeration, an ordered or exhaustive listing, a value from each progress line, machine-readable structure, or a complete evidence set. Assign low probability only when retained context and omission markers preserve every fact needed by the task.

Stop after evaluating all task fields and the available candidate text in `segments` together with `output_head` and `output_tail`.
{{/if}}
