---
title: {{#severity}}[{{severity}}] {{/severity}}{{title}}
---
{{#steps}}
**Steps to reproduce:**
{{steps}}
{{/steps}}

{{#expected}}
**Expected:** {{expected}}
{{/expected}}

{{#actual}}
**Actual:** {{actual}}
{{/actual}}

{{#notes}}
**Notes:**
{{notes}}
{{/notes}}

{{^structured}}
{{body}}
{{/structured}}

---

{{#environment}}
**Environment:** {{environment}}

{{/environment}}
{{#severity}}
**Severity:** {{severity}}{{#layer}} · **Layer:** {{layer}}{{/layer}}

{{/severity}}
**Source:** QC run `{{ticket}}`{{#run_date}} · {{run_date}}{{/run_date}}
