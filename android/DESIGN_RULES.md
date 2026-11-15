# Design rules: Pocket Switchboard

Read this before you change any product screen in `app/src/main/java/app/kainos/talk/ui/talk/`.

## Source of truth

The approved design is the mockup in `design/pocket-switchboard/` (`index.html` and `shots/`). The user picked it out of three directions, so it is the visual identity. Do not invent new colours, type sizes or shapes; when the mockup lacks something, derive it from the tokens below.

The phone app is now a background bridge for texts: it has only the setup screen and Connect to PC, its home screen. The mockup's inbox, thread, mail and socket board are history; the theme keeps only the tokens these two screens use.

## Tokens

| What | File |
|---|---|
| Colours (light and dark, named as in the mockup's CSS) and the Material role mapping | `ui/theme/Color.kt` |
| Atkinson Hyperlegible, the only typeface, and the type scale | `ui/theme/Type.kt` |
| Shapes | `ui/theme/Shape.kt` |
| Spacing (4 dp grid) and component sizes | `ui/theme/Spacing.kt` |
| `KainosTheme` and the `MaterialTheme.switchboard`, `.spacing`, `.sizes` accessors | `ui/theme/Theme.kt` |

The font files are in `res/font/`; their licence (SIL OFL 1.1) ships in `assets/licenses/`.

## Rules

- Screens take every size and colour from the theme. `DesignTokensTest` fails on a raw `dp`, `sp` or `Color(0x…)` in `ui/talk/`.
- Text meets WCAG AA (4.5:1) and controls and borders meet 3:1 in both themes. `ContrastTest` computes every pair from the theme values and writes `app/build/reports/contrast.md`.
- Touch targets are at least 48 dp. Each computer in the list and each setup step has a TalkBack label.
- Text scales with the system font size.
- The only drawn mark is the app mark (`AppMark` in `ui/talk/Parts.kt`). If an icon is ever needed, draw it in the mockup's own line style (24 grid, 1.8 stroke, round caps); do not mix in Material Symbols.
- No dynamic colour: the palette is the identity.
- Copy is sentence case with plain verbs, and talks about texts, the phone and the computer.

## Verify

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
./gradlew :app:verifyRoborazziDebug   # compares against app/src/test/screenshots
./gradlew :app:recordRoborazziDebug   # re-records after an intended visual change; look at every changed PNG
```
