<system-notice>
Background {{type}} job {{jobId}}{{#if label}} ({{label}}){{/if}} has reported no progress for {{sinceProgressSec}}s. Running {{elapsedSec}}s; {{#if timeoutSec}}times out after {{timeoutSec}}s{{else}}no timeout{{/if}}. This warning is sent once.
{{#if lastOutput}}Last output:
```
{{lastOutput}}
```
{{/if}}Inspect its stderr/log once (`hub` op:"jobs", or `artifact://` for its captured output). If it is waiting on input or stuck, stop it now with `hub` op:"cancel" ids:["{{jobId}}"] rather than waiting on it.
</system-notice>
