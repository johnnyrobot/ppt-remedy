# ADR 0002: Decorative marking is read-only until DEC-01 passes

- Status: accepted; revisit after the phase 0 PowerPoint fixture spike
- Spec: §16 "Supported changes by release", §21 T02, §22 DEC-01

## Decision

The scanner reads a decorative marker from `p:cNvPr/a:extLst/a:ext` with URI
`{C183D7F6-B498-43B3-948B-1728B52AA6E4}` and element `adec:decorative@val`, namespace
`http://schemas.microsoft.com/office/drawing/2017/decorative`. That marker is used only to
avoid flagging known-decorative pictures as missing alt text.

**Writing** the marker is disabled (`FEATURES.decorativeToggle = false`). The export engine
rejects `set_decorative` with `PATCH_UNSUPPORTED`. The UI tells users to mark decorative in
PowerPoint and then dismiss the finding with a reason.

## To enable (DEC-01)

1. Author true/false/toggled fixtures in current Microsoft 365 PowerPoint (Windows and Mac)
   and commit the exact before/after XML under `fixtures/office-authored/`.
2. Confirm the namespace, extension URI, `a:extLst` ordering relative to other extensions,
   and how `descr` is handled when an existing description is present.
3. Implement a splice recipe that inserts or updates the extension while preserving
   unrelated extensions, and add it to the verification allowlist.
4. Verify PowerPoint's Alt Text pane, the Accessibility Checker and a screen reader agree.
   Then flip the flag and record the evidence.
