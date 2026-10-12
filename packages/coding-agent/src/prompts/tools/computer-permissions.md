macOS withholds desktop automation until the launching application is granted TCC permissions. Grant them yourself; no API can request them for you.

{{#if accessibility}}
- Accessibility (keyboard, mouse, and accessibility-tree control): System Settings > Privacy & Security > Accessibility - enable the application that launched this agent.
{{/if}}
{{#if screenRecording}}
- Screen Recording (window enumeration and screenshots): System Settings > Privacy & Security > Screen Recording - enable the application that launched this agent.
{{/if}}

Quit and relaunch the application after granting a permission; macOS only re-reads the grant on process start.
