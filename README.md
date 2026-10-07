# Segmented Thermostat Card

A Home Assistant thermostat card with a **segmented slider**: one coloured segment per temperature step. The target is the white thumb, the measured room temperature is the small thermometer.

![Default layout](docs/screenshot-default.png)
![Compact layout](docs/screenshot-compact.png)

## Install
HACS → ⋮ → **Custom repositories** → add `https://github.com/pitrade/lovelace-segmented-thermostat-card` as **Dashboard** → install → reload the browser.

## Use
```yaml
type: custom:segmented-thermostat-card
entity: climate.living_room
```

| Option | Default | |
|---|---|---|
| `entity` | required | `climate.*` entity |
| `name` | entity name | Title (default layout) |
| `min_temp`, `max_temp`, `step_size` | 12, 24, 0.5 | Slider range and step |
| `window_sensor` | – | Optional `binary_sensor`; without it there is no window icon |
| `show_current_temp` | `true` | Measured temperature (taken from the climate entity, no sensor needed) |
| `show_window` | `true` | Window icon (only shown if `window_sensor` is set) |
| `compact` | `false` | One-row layout without title |
| `presets` | all the entity offers | Pick, order and style the preset buttons (below) |

## Presets
Buttons come from the entity's own `preset_modes` (except `none`), with localised names and an icon per preset. Tapping the active preset resets it to `none`. To pick or restyle them:

```yaml
presets:
  - mode: eco
    color_temperature: 17   # colour of the slider segment for 17 °C (colouring only, sets nothing)
  - mode: comfort
    color_temperature: 21
  - mode: boost
    color: "#ff5722"        # or any CSS colour
```
Other keys per preset: `name`, `icon`. In `compact` mode the top row has three columns (info | target | right); place a preset with `column: left|right` and `align: left|right`.

## Notes
Needs a `climate` entity that supports `climate.set_temperature`; preset buttons only appear if it offers `preset_modes`. Tested in a mock harness (Chromium, Firefox, WebKit) and on Home Assistant 2026.9 in Chromium; not on real phones or tablets.

GPL-3.0-or-later.
