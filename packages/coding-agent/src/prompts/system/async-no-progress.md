<system-notice>
Background {{type}} job {{jobId}}{{#if label}} ({{label}}){{/if}} has reported no progress for {{sinceProgressSec}}s. Running {{elapsedSec}}s; {{#if timeoutSec}}times out after {{timeoutSec}}s{{else}}no timeout{{/if}}. This warning is sent once.
{{#if lastOutput}}Last output:
```
{{lastOutput}}
```
{{/if}}Inspect its status/output once (`read proc://{{jobId}}`; `artifact://` for captured output). If it is waiting on input or stuck, stop it now with `write proc://{{jobId}}/kill` (omit `content`) rather than waiting on it.
</system-notice>
