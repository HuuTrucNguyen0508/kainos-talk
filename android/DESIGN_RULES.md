# Design rules: Pocket Switchboard

Read this before you change any product screen in `app/src/main/java/app/kainos/talk/ui/talk/`.

## Source of truth

The approved design is the mockup in `design/pocket-switchboard/` (`index.html` and `shots/`). The user picked it out of three directions, so it is the visual identity. Do not invent new colours, type sizes or shapes; when the mockup lacks something, derive it from the tokens below.

## Tokens

| What | File |
|---|---|
| Colours (light and dark, named as in the mockup's CSS) and the Material role mapping | `ui/theme/Color.kt` |
| Atkinson Hyperlegible, the only typeface, and the type scale | `ui/theme/Type.kt` |
| Shapes, including the socket tab and the source jacks | `ui/theme/Shape.kt` |
| Spacing (4 dp grid) and component sizes | `ui/theme/Spacing.kt` |
| `KainosTheme` and the `MaterialTheme.switchboard`, `.spacing`, `.sizes` accessors | `ui/theme/Theme.kt` |

The font files are in `res/font/`; their licence (SIL OFL 1.1) ships in `assets/licenses/`.

## Rules

- Screens take every size and colour from the theme. `DesignTokensTest` fails on a raw `dp`, `sp` or `Color(0x…)` in `ui/talk/`.
- Text meets WCAG AA (4.5:1) and controls and borders meet 3:1 in both themes. `ContrastTest` computes every pair from the theme values and writes `app/build/reports/contrast.md`.
- Touch targets are at least 48 dp. Every icon-only control has a content description. Inbox rows and sockets give TalkBack the source and the unread count.
- Text scales with the system font size. Only glyphs inside fixed shapes (jack letters, tile letters, initials, the lamp on a tile past 130%) stay fixed, and their parent carries the TalkBack label.
- Icons are the mockup's own line set in `ui/talk/Icons.kt` (24 grid, 1.8 stroke, round caps). Do not mix in Material Symbols.
- No dynamic colour: the palette is the identity.
- Copy is in `ui/talk/Copy.kt`: sentence case, plain verbs, and app names from the hub's `Source.label`.

## Verify

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
./gradlew :app:verifyRoborazziDebug   # compares against app/src/test/screenshots
./gradlew :app:recordRoborazziDebug   # re-records after an intended visual change; look at every changed PNG
```
