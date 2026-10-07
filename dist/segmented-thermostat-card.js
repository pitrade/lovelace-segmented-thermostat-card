/*
 * Segmented Thermostat Card
 * Copyright (C) 2026 Marc Hinterthaner
 * License: GPL-3.0-or-later (see LICENSE)
 */
const CARD_VERSION = '1.1.0';

console.info(
  `%c SEGMENTED-THERMOSTAT %c v${CARD_VERSION} `,
  'color: white; background: #03a9f4; font-weight: 700;',
  'color: #03a9f4; background: white; font-weight: 700;'
);

// Icons for the preset names Home Assistant knows (https://developers.home-assistant.io/docs/core/entity/climate);
// anything else falls back to a generic icon and can be overridden with the `presets` option.
const PRESET_ICONS = {
  eco: 'mdi:leaf',
  comfort: 'mdi:sofa',
  boost: 'mdi:fire',
  away: 'mdi:home-export-outline',
  home: 'mdi:home',
  sleep: 'mdi:power-sleep',
  activity: 'mdi:motion-sensor',
};
const PRESET_FALLBACK_ICON = 'mdi:tune-variant';

class SegmentedThermostatCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._debounceTimer = null;
    this._isInteracting = false;
    this._optimisticTemp = null;
    this._optimisticPreset = null;
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error('Please define an entity');
    }

    const cfg = {
      step_size: 0.5,
      min_temp: 12,
      max_temp: 24,
      debounce: 1000,
      compact: false,
      window_sensor: null,
      ...config,
    };
    // numeric range config: coerce (YAML strings) and reject values that would break the
    // segment count (step <= 0 used to loop forever)
    for (const k of ['min_temp', 'max_temp', 'step_size']) {
      cfg[k] = Number(cfg[k]);
      if (!Number.isFinite(cfg[k])) throw new Error(`${k} must be a number`);
    }
    if (cfg.step_size <= 0) throw new Error('step_size must be greater than 0');
    if (cfg.max_temp < cfg.min_temp) throw new Error('max_temp must not be below min_temp');
    this.config = cfg;

    // config changed on an already rendered card (e.g. the dashboard editor preview): rebuild
    if (this.entity) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const entity = hass.states[this.config.entity];
    if (!entity) {
      this.shadowRoot.innerHTML = `<ha-card><div style="padding:16px;color:red;">Entity not available</div></ha-card>`;
      this.entity = undefined; // full re-render once the entity is back
      return;
    }

    const oldEntity = this.entity;
    this.entity = entity;

    // Only render if first time or if we need full re-render
    if (!oldEntity) {
      this._render();
    } else if (JSON.stringify(this._getPresets()) !== this._presetSignature) {
      this._render(); // the entity now offers different presets
    } else {
      // Just update the values, don't re-render everything
      this._updateValues();
    }
  }

  _render() {
    if (!this.entity) return;

    const {
      current_temperature,
      temperature,
      preset_mode,
      friendly_name = 'Thermostat'
    } = this.entity.attributes;

    // One equal segment per selectable step; draw a 2px divider centred on each
    // internal boundary (i/numSegments of the track). Explicit stops = exact and
    // drift-free, so the segments line up perfectly with the thermometer icon.
    const numSegments = Math.round((this.config.max_temp - this.config.min_temp) / this.config.step_size) + 1;
    const dividerStops = [];
    for (let i = 1; i < numSegments; i++) {
      const p = (100 * i / numSegments).toFixed(4);
      dividerStops.push(
        `transparent calc(${p}% - 1px)`,
        `var(--secondary-background-color) calc(${p}% - 1px)`,
        `var(--secondary-background-color) calc(${p}% + 1px)`,
        `transparent calc(${p}% + 1px)`
      );
    }
    const dividerGradient = `linear-gradient(to right, transparent 0, ${dividerStops.join(', ')}, transparent 100%)`;

    const compact = this.config.compact === true;
    // compact slider: one element per selectable step; thumb and thermometer are children of a
    // segment, so their alignment comes from layout alone (no calc()/rounding drift)
    // Segment i shows slice i of one gradient N segments wide (background-size N*100%,
    // position i/(N-1)), so the colours run continuously and the gaps eat no colour.
    let segHtml = '';
    {
      const { min, max, n } = this._grid();
      const sliderVal = temperature || min;
      let segs = '';
      for (let i = 0; i < n; i++) {
        const pos = n > 1 ? (100 * i / (n - 1)).toFixed(4) : 0;
        segs += `<div class="seg" style="background-size: ${n * 100}% 100%; background-position: ${pos}% 0;">${i === 0 ? '<span class="seg-thumb" id="seg-thumb" aria-hidden="true"></span><ha-icon class="seg-therm" id="seg-therm" icon="mdi:thermometer" aria-hidden="true"></ha-icon>' : ''}</div>`;
      }
      segHtml = `<div class="slider-wrapper">
            <div class="seg-track" id="seg-track" role="slider" tabindex="0" aria-label="${String(this.config.name || friendly_name).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${sliderVal}">${segs}</div>
            <input type="range" id="slider" hidden min="${min}" max="${max}" step="${this.config.step_size}" value="${sliderVal}">
          </div>`;
    }
    const headerRightHtml = `<div class="header-right">
            ${this._renderWindowIcon()}
            ${compact ? `<div class="temp-wrap"><ha-icon class="temp-ico" icon="mdi:thermometer"></ha-icon><div class="current-temp">${current_temperature || '—'}°C</div></div>` : `<div class="current-temp">${current_temperature || '—'}°C</div>`}
          </div>`;
    const presets = this._getPresets();
    this._presetSignature = JSON.stringify(presets);
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const modesHtml = presets.length === 0 ? '' : `<div class="modes">${presets.map(({ mode, name, icon }) => `
            <button class="mode-btn ${mode === preset_mode ? 'active' : ''}" data-preset="${esc(mode)}"${compact ? ` title="${esc(name)}" aria-label="${esc(name)}"` : ''}>
              <ha-icon icon="${esc(icon)}"></ha-icon>
              <span>${esc(name)}</span>
            </button>`).join('')}</div>`;

    this.shadowRoot.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        ha-card { padding: 12px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .name { font-size: 20px; font-weight: 500; }
        .header-right { display: flex; gap: 12px; align-items: center; }
        .current-temp { font-size: 14px; font-weight: 500; }

        .temp-control { background: var(--secondary-background-color); border-radius: 12px; padding: 6px; margin-bottom: 12px; }

        .temp-mid { display: contents; }
        .temp-row { display: flex; align-items: center; justify-content: center; gap: 12px; }
        .target-temp { text-align: center; font-size: 32px; font-weight: 500; min-width: 120px; transition: color 0.2s, opacity 0.2s; }
        .target-temp.updating { color: var(--secondary-text-color); opacity: 0.5; }

        .slider-wrapper {
          position: relative;
          display: flex;
          align-items: center;
        }

        .slider-track-bg {
          position: absolute;
          left: 4px;
          right: 4px;
          top: 50%;
          transform: translateY(-50%);
          height: 32px;
          background:
            linear-gradient(90deg,
              rgba(74, 144, 226, 0.85) 0%,
              rgba(91, 163, 245, 0.85) 15%,
              rgba(124, 184, 255, 0.85) 30%,
              rgba(165, 172, 176, 0.85) 50%,
              rgba(203, 159, 116, 0.85) 70%,
              rgba(219, 110, 91, 0.85) 85%,
              rgba(220, 107, 107, 0.85) 100%
            );
          border-radius: 2px;
          box-shadow:
            inset 0 2px 3px rgba(0, 0, 0, 0.3),
            0 1px 1px rgba(255, 255, 255, 0.1);
          pointer-events: none;
          z-index: 0;
          overflow: hidden;
        }
        .current-temp-indicator {
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          z-index: 2;
          pointer-events: none;
          color: var(--secondary-background-color);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
          transition: left 0.3s ease;
        }
        .current-temp-indicator ha-icon {
          --mdc-icon-size: 16px;
        }
        .slider-track-bg::after {
          content: '';
          position: absolute;
          inset: 0;
          background: ${dividerGradient};
          pointer-events: none;
        }
        .btn {
          width: 40px;
          height: 40px;
          border-radius: 8px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        .btn:hover {
          background: var(--secondary-background-color);
        }
        .btn:active {
          transform: scale(0.95);
        }
        .btn.active {
          background: var(--primary-color);
          color: white;
          border-color: var(--primary-color);
        }

        input[type="range"] {
          position: relative;
          width: 100%;
          height: 48px;
          margin: 0;
          padding: 0;
          -webkit-appearance: none;
          background: transparent;
          cursor: pointer;
          touch-action: none;
          z-index: 1;
        }
        input[type="range"]:focus {
          outline: none;
        }

        /* Webkit Track */
        input[type="range"]::-webkit-slider-track {
          width: 100%;
          height: 32px;
          border-radius: 2px;
          background: transparent;
        }

        /* Webkit Thumb */
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 20px;
          height: 40px;
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
          border: 2px solid rgba(255,255,255,0.9);
          border-radius: 2px;
          cursor: grab;
          margin-top: 0;
          box-shadow:
            0 2px 8px rgba(0,0,0,0.3),
            inset 0 1px 2px rgba(255,255,255,0.6),
            inset 0 -1px 1px rgba(0,0,0,0.15);
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        input[type="range"]::-webkit-slider-thumb:hover {
          transform: scale(1.1);
          box-shadow:
            0 3px 12px rgba(0,0,0,0.4),
            inset 0 1px 2px rgba(255,255,255,0.7);
        }
        input[type="range"]::-webkit-slider-thumb:active {
          cursor: grabbing;
          transform: scale(1.05);
          box-shadow:
            0 1px 4px rgba(0,0,0,0.4),
            inset 0 1px 2px rgba(255,255,255,0.5);
        }

        /* Firefox Track */
        input[type="range"]::-moz-range-track {
          width: 100%;
          height: 32px;
          border-radius: 2px;
          background: transparent;
          border: none;
        }

        /* Firefox Thumb */
        input[type="range"]::-moz-range-thumb {
          width: 20px;
          height: 40px;
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
          border: 2px solid rgba(255,255,255,0.9);
          border-radius: 2px;
          cursor: grab;
          box-shadow:
            0 2px 8px rgba(0,0,0,0.3),
            inset 0 1px 2px rgba(255,255,255,0.6),
            inset 0 -1px 1px rgba(0,0,0,0.15);
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        input[type="range"]::-moz-range-thumb:hover {
          transform: scale(1.1);
          box-shadow:
            0 3px 12px rgba(0,0,0,0.4),
            inset 0 1px 2px rgba(255,255,255,0.7);
        }
        input[type="range"]::-moz-range-thumb:active {
          cursor: grabbing;
          transform: scale(1.05);
          box-shadow:
            0 1px 4px rgba(0,0,0,0.4),
            inset 0 1px 2px rgba(255,255,255,0.5);
        }

        .modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 8px; }
        .mode-btn {
          padding: 6px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          background: var(--card-background-color);
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          transition: all 0.2s;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        .mode-btn:hover {
          background: var(--secondary-background-color);
        }
        .mode-btn.active {
          background: var(--primary-color);
          color: white;
          border-color: var(--primary-color);
        }
        .mode-btn.updating {
          opacity: 0.4;
        }
        .mode-btn span { font-size: 11px; font-weight: 500; }

        /* compact: no header; one row in 3 segments (temp + window | target control | presets as icons) + slider */
        ha-card.compact { padding: 8px; }
        .compact .temp-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px; }
        .compact .temp-mid { display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; }
        .compact .header-right { justify-self: start; flex-direction: row-reverse; gap: 4px; padding-left: 4px; }
        .compact .temp-wrap { display: flex; align-items: center; }
        .compact .current-temp { font-size: 16px; white-space: nowrap; }
        /* compact slider: one .seg per step; thumb and thermometer are children of a segment, so they
           are centred on it by layout alone. The track is 48px tall (touch target), segments 32px. */
        .slider-wrapper:has(.seg-track) { display: block; }
        .seg-track { display: flex; gap: 2px; height: 48px; padding: 8px 0 8px; margin: 0 4px; direction: ltr; isolation: isolate;
          cursor: pointer; touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
        .seg-track:focus { outline: none; }
        .seg-track:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 0; border-radius: 4px; }
        .seg { position: relative; flex: 1 1 0; min-width: 0; border-radius: 1px; box-shadow: inset 0 2px 3px rgba(0, 0, 0, 0.3);
          background-image: linear-gradient(90deg, rgba(74, 144, 226, 0.85) 0%, rgba(91, 163, 245, 0.85) 15%, rgba(124, 184, 255, 0.85) 30%, rgba(165, 172, 176, 0.85) 50%, rgba(203, 159, 116, 0.85) 70%, rgba(219, 110, 91, 0.85) 85%, rgba(220, 107, 107, 0.85) 100%); }
        .seg:first-child { border-radius: 2px 1px 1px 2px; }
        .seg:last-child { border-radius: 1px 2px 2px 1px; }
        .seg:only-child { border-radius: 2px; }
        .seg-thumb { position: absolute; left: 50%; top: 50%; width: 16px; height: 36px; margin: -18px 0 0 -8px; box-sizing: border-box; z-index: 1; pointer-events: none;
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); border: 2px solid rgba(255, 255, 255, 0.9); border-radius: 2px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), inset 0 1px 2px rgba(255, 255, 255, 0.6), inset 0 -1px 1px rgba(0, 0, 0, 0.15);
          transition: transform 0.15s ease, box-shadow 0.15s ease; }
        .seg-track.dragging .seg-thumb { transform: scale(1.05); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4), inset 0 1px 2px rgba(255, 255, 255, 0.5); }
        .seg-therm { position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; --mdc-icon-size: 16px; z-index: 2; pointer-events: none;
          display: flex; color: var(--secondary-background-color); filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5)); }
        /* measured and target temperature on the same step: dark icon on the light thumb */
        .seg-therm.on-thumb { color: rgba(0, 0, 0, 0.7); filter: none; }
        @media (prefers-reduced-motion: reduce) { .seg-thumb { transition: none; } }
        .compact .modes { justify-self: end; margin-right: 4px; }
        .compact .temp-control { margin-bottom: 0; padding: 0; background: none; border-radius: 0; }
        .compact .target-temp { font-size: 22px; min-width: 56px; white-space: nowrap; }
        .compact .btn { width: 32px; height: 32px; }
        .compact .modes { display: flex; gap: 4px; }
        .compact .mode-btn { width: 32px; height: 32px; padding: 0; justify-content: center; }
        .compact .mode-btn span { display: none; }
      </style>
      <ha-card class="${compact ? 'compact' : ''}">
        ${compact ? '' : `<div class="header">
          <div class="name">${this.config.name || friendly_name}</div>
          ${headerRightHtml}
        </div>
`}
        <div class="temp-control">
          <div class="temp-row">
            ${compact ? headerRightHtml : ''}
            <div class="temp-mid">
              <button class="btn" id="dec"><ha-icon icon="mdi:minus"></ha-icon></button>
              <div class="target-temp" id="target">${temperature || '—'}°C</div>
              <button class="btn" id="inc"><ha-icon icon="mdi:plus"></ha-icon></button>
            </div>
            ${compact ? modesHtml : ''}
          </div>
          ${segHtml}
        </div>

        ${compact ? '' : modesHtml}
      </ha-card>
    `;

    this._attach();
    this._updateTempIndicator();
    this._updateSegs();
  }

  // Compact slider grid: the values the (hidden) range input can actually take. floor, not round:
  // when the range is not a multiple of the step the input stops at the last step below max,
  // so a round()-ed count would add a segment nobody can select. The epsilon absorbs float
  // error such as (24 - 12) / 0.1 = 119.99999999999999.
  _grid() {
    const { min_temp: min, step_size: step } = this.config;
    const n = Math.floor((this.config.max_temp - min) / step + 1e-7) + 1;
    const val = (i) => parseFloat((min + i * step).toFixed(10));
    return { min, step, n, max: val(n - 1), val };
  }

  // Compact mode: move the thumb into the segment of the target value and the thermometer into
  // the segment of the measured temperature (nearest step, clamped to the range).
  _updateSegs() {
    const track = this.shadowRoot.getElementById('seg-track');
    const slider = this.shadowRoot.getElementById('slider');
    const thumb = this.shadowRoot.getElementById('seg-thumb');
    const icon = this.shadowRoot.getElementById('seg-therm');
    if (!track || !slider || !thumb || !icon) return;
    const { min, step } = this._grid();
    const segs = track.children;
    const idx = (v) => Math.min(segs.length - 1, Math.max(0, Math.round((v - min) / step)));
    const value = parseFloat(slider.value);
    const thumbSeg = segs[idx(value)];
    if (thumb.parentNode !== thumbSeg) thumbSeg.appendChild(thumb);
    track.setAttribute('aria-valuenow', value);
    track.setAttribute('aria-valuetext', `${value} °C`);
    const raw = this.entity && this.entity.attributes.current_temperature;
    const cur = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(cur)) {
      icon.style.display = 'none';
    } else {
      icon.style.display = '';
      const indSeg = segs[idx(cur)];
      if (icon.parentNode !== indSeg) indSeg.appendChild(icon);
      icon.classList.toggle('on-thumb', indSeg === thumbSeg);
    }
  }

  _updateTempIndicator() {
    const { current_temperature } = this.entity.attributes;
    const indicator = this.shadowRoot.getElementById('temp-indicator');

    if (!indicator || current_temperature === undefined || current_temperature === null) {
      if (indicator) indicator.style.display = 'none';
      return;
    }

    // Snap the measured temperature to the nearest selectable step, then clamp
    const step = this.config.step_size;
    const roundedTemp = Math.round(current_temperature / step) * step;
    const clampedTemp = Math.max(this.config.min_temp, Math.min(this.config.max_temp, roundedTemp));

    // The track (see .slider-track-bg: left/right 4px) is split into one equal
    // segment per selectable step. Center the icon in the segment for this temp.
    // Pure calc() keeps it pixel-exact and responsive on any width — no offsetWidth,
    // no resize handling: 100% = wrapper width, (100% - 8px) = track width.
    const inset = 4; // matches .slider-track-bg left/right
    const numSegments = Math.round((this.config.max_temp - this.config.min_temp) / step) + 1;
    const segmentIndex = Math.round((clampedTemp - this.config.min_temp) / step);
    const factor = segmentIndex + 0.5; // center of that segment

    indicator.style.display = 'block';
    indicator.style.left = `calc(${inset}px + ${factor} * (100% - ${inset * 2}px) / ${numSegments})`;
  }

  _updateValues() {
    const { current_temperature, temperature, preset_mode } = this.entity.attributes;

    const currentTempEl = this.shadowRoot.querySelector('.current-temp');
    const targetEl = this.shadowRoot.getElementById('target');
    const slider = this.shadowRoot.getElementById('slider');
    const headerRight = this.shadowRoot.querySelector('.header-right');

    // Update current temperature display
    if (currentTempEl) currentTempEl.textContent = `${current_temperature || '—'}°C`;

    // Update window icon
    if (headerRight && this.config.window_sensor) {
      const windowEntity = this._hass.states[this.config.window_sensor];
      if (windowEntity) {
        const existingIcon = headerRight.querySelector('ha-icon:not(.temp-ico)');
        if (existingIcon) {
          const isOpen = windowEntity.state === 'on';
          const icon = isOpen ? 'mdi:window-open' : 'mdi:window-closed';
          existingIcon.setAttribute('icon', icon);
          if (isOpen) {
            existingIcon.style.color = 'var(--state-binary_sensor-on-color, var(--state-on-color, #ff9800))';
          } else {
            existingIcon.style.color = 'var(--state-binary_sensor-off-color, var(--state-off-color))';
          }
        }
      }
    }

    // Check if entity value matches our optimistic value
    if (this._optimisticTemp !== null && Math.abs(temperature - this._optimisticTemp) < 0.01) {
      // Entity confirmed our change, clear optimistic state
      this._optimisticTemp = null;
      this._isInteracting = false;
      if (targetEl) targetEl.classList.remove('updating');
    }

    // Check if preset matches our optimistic preset
    if (this._optimisticPreset !== null && preset_mode === this._optimisticPreset) {
      this._optimisticPreset = null;
    }

    // Update slider and target temperature only if not currently interacting
    if (!this._isInteracting && slider) {
      slider.value = temperature || this.config.min_temp;
      if (targetEl) {
        targetEl.textContent = `${temperature || '—'}°C`;
        targetEl.classList.remove('updating');
      }
    }

    // Update preset buttons
    const displayPreset = this._optimisticPreset !== null ? this._optimisticPreset : preset_mode;
    this.shadowRoot.querySelectorAll('.mode-btn').forEach(btn => {
      const isActive = btn.dataset.preset === displayPreset;
      const isUpdating = this._optimisticPreset !== null;

      if (isActive) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }

      if (isUpdating && isActive) {
        btn.classList.add('updating');
      } else {
        btn.classList.remove('updating');
      }
    });

    // Update thermometer indicator position
    this._updateTempIndicator();
    this._updateSegs();
  }

  _attach() {
    const slider = this.shadowRoot.getElementById('slider');
    const target = this.shadowRoot.getElementById('target');
    const dec = this.shadowRoot.getElementById('dec');
    const inc = this.shadowRoot.getElementById('inc');

    // Slider input - update UI immediately
    slider.addEventListener('input', (e) => {
      this._updateSegs();
      this._isInteracting = true;
      this._optimisticTemp = parseFloat(e.target.value);
      target.textContent = `${e.target.value}°C`;
      target.classList.add('updating');
    });

    // Slider change - send to backend
    slider.addEventListener('change', (e) => {
      this._optimisticTemp = parseFloat(e.target.value);
      this._set(this._optimisticTemp);
    });

    // Compact segmented slider: pointer and keyboard pick a segment index and drive the hidden
    // input through synthetic input/change events, so the handlers above stay the single path.
    const track = this.shadowRoot.getElementById('seg-track');
    if (track) {
      const { min, step, n, val } = this._grid();
      const index = () => Math.round((parseFloat(slider.value) - min) / step);
      const setIndex = (i) => {
        const v = val(Math.min(n - 1, Math.max(0, i)));
        if (parseFloat(slider.value) === v) return;
        slider.value = v;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const commit = () => slider.dispatchEvent(new Event('change', { bubbles: true }));
      // Equal pitch per segment (segment + one gap); each gap is split at its middle, so every
      // point of a segment maps to that segment, the ends included.
      const fromX = (x) => {
        const r = track.getBoundingClientRect();
        const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
        return Math.floor((x - r.left + gap / 2) / ((r.width + gap) / n));
      };

      // One drag at a time. touch-action: pan-y leaves vertical swipes to the browser (page
      // scroll, ending in pointercancel). So touch applies only on lift or once the finger has
      // moved mainly sideways; a cancel restores the state from before the touch.
      let drag = null;
      track.addEventListener('pointerdown', (e) => {
        if (drag || !e.isPrimary || e.button !== 0) return;
        drag = {
          id: e.pointerId,
          x0: e.clientX,
          y0: e.clientY,
          locked: e.pointerType !== 'touch',
          start: slider.value,
          snap: { value: slider.value, interacting: this._isInteracting, optimistic: this._optimisticTemp,
            text: target.textContent, updating: target.classList.contains('updating') },
        };
        try { track.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
        track.classList.add('dragging');
        if (drag.locked) setIndex(fromX(e.clientX));
      });
      track.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (!drag.locked) {
          const dx = Math.abs(e.clientX - drag.x0);
          if (dx < 4 || dx <= Math.abs(e.clientY - drag.y0)) return;
          drag.locked = true;
        }
        setIndex(fromX(e.clientX));
      });
      const finish = (e, ok) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        track.classList.remove('dragging');
        if (ok) {
          setIndex(fromX(e.clientX));
          if (slider.value !== d.start) commit(); // like a native range: change only if moved
          return;
        }
        const s = d.snap;
        slider.value = s.value;
        this._isInteracting = s.interacting;
        this._optimisticTemp = s.optimistic;
        target.textContent = s.text;
        target.classList.toggle('updating', s.updating);
        if (!s.interacting && this.entity) this._updateValues(); // catch up with hass meanwhile
        else this._updateSegs();
      };
      track.addEventListener('pointerup', (e) => finish(e, true));
      track.addEventListener('pointercancel', (e) => finish(e, false));
      track.addEventListener('lostpointercapture', (e) => finish(e, false)); // after pointerup: no-op

      const big = Math.max(2, Math.round(1 / step)); // PageUp/PageDown: about 1 °C
      track.addEventListener('keydown', (e) => {
        const k = index();
        const keys = { ArrowLeft: k - 1, ArrowDown: k - 1, ArrowRight: k + 1, ArrowUp: k + 1,
          PageDown: k - big, PageUp: k + big, Home: 0, End: n - 1 };
        if (!(e.key in keys) || e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        const before = slider.value;
        setIndex(keys[e.key]);
        if (slider.value !== before) commit();
      });
    }

    // Step the target temperature by one increment, clamped to the range
    const nudge = (delta) => {
      this._isInteracting = true;
      const base = this._optimisticTemp !== null ? this._optimisticTemp : parseFloat(slider.value);
      // slider.min/max: the configured range (normal mode) or the last selectable step (compact);
      // toFixed strips float drift such as 20.1 + 0.1 = 20.200000000000003
      const newVal = parseFloat(Math.min(Math.max(base + delta, parseFloat(slider.min)), parseFloat(slider.max)).toFixed(10));
      this._optimisticTemp = newVal;
      slider.value = newVal;
      this._updateSegs();
      target.textContent = `${newVal}°C`;
      target.classList.add('updating');
      this._set(newVal);
    };
    dec.addEventListener('click', () => nudge(-this.config.step_size));
    inc.addEventListener('click', () => nudge(this.config.step_size));

    // Preset mode buttons
    this.shadowRoot.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const clickedPreset = btn.dataset.preset;
        const attrs = this.entity.attributes;
        const currentPreset = this._optimisticPreset !== null ? this._optimisticPreset : attrs.preset_mode;

        // Tapping the active preset again resets it, if the entity offers 'none'
        let targetPreset = clickedPreset;
        if (clickedPreset === currentPreset) {
          if ((attrs.preset_modes || []).includes('none')) targetPreset = 'none';
          else return;
        }

        // Set optimistic preset for immediate UI feedback
        this._optimisticPreset = targetPreset;

        // Update button states immediately
        this.shadowRoot.querySelectorAll('.mode-btn').forEach(b => {
          if (b.dataset.preset === targetPreset) {
            b.classList.add('active', 'updating');
          } else {
            b.classList.remove('active', 'updating');
          }
        });

        // Send service call to backend
        this._hass.callService('climate', 'set_preset_mode', {
          entity_id: this.config.entity,
          preset_mode: targetPreset,
        });
      });
    });
  }

  _set(temp) {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._hass.callService('climate', 'set_temperature', {
        entity_id: this.config.entity,
        temperature: temp,
      });
    }, this.config.debounce);
  }

  // Presets come from the entity (`preset_modes`, without 'none'). `presets` (optional) filters and orders them:
  // a list of mode names or objects { mode, name, icon }. Configured modes the entity does not offer are hidden.
  _getPresets() {
    const attrs = (this.entity && this.entity.attributes) || {};
    const offered = (attrs.preset_modes || []).filter((m) => m !== 'none');
    let list;
    if (Array.isArray(this.config.presets)) {
      list = this.config.presets
        .map((p) => (typeof p === 'string' ? { mode: p } : p))
        .filter((p) => p && p.mode && offered.includes(p.mode));
    } else {
      list = offered.map((mode) => ({ mode }));
    }
    return list.map((p) => ({
      mode: p.mode,
      name: p.name || this._presetName(p.mode),
      icon: p.icon || PRESET_ICONS[p.mode] || PRESET_FALLBACK_ICON,
    }));
  }

  _presetName(mode) {
    try {
      const v = this._hass && this._hass.formatEntityAttributeValue
        ? this._hass.formatEntityAttributeValue(this.entity, 'preset_mode', mode)
        : null;
      if (v) return String(v);
    } catch (e) { /* fall through to the raw name */ }
    return mode.charAt(0).toUpperCase() + mode.slice(1).replace(/_/g, ' ');
  }

  _renderWindowIcon() {
    if (!this.config.window_sensor) return '';

    const windowEntity = this._hass.states[this.config.window_sensor];
    if (!windowEntity) return '';

    const isOpen = windowEntity.state === 'on';
    const icon = isOpen ? 'mdi:window-open' : 'mdi:window-closed';
    const color = isOpen
      ? 'var(--state-binary_sensor-on-color, var(--state-on-color, #ff9800))'
      : 'var(--state-binary_sensor-off-color, var(--state-off-color))';

    return `<ha-icon icon="${icon}" style="color: ${color};"></ha-icon>`;
  }

  getCardSize() {
    return this.config && this.config.compact ? 2 : 3;
  }

  static getStubConfig() {
    return {
      entity: '',
      min_temp: 8,
      max_temp: 28,
      step_size: 0.5
    };
  }
}

customElements.define('segmented-thermostat-card', SegmentedThermostatCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'segmented-thermostat-card', name: 'Segmented Thermostat', description: 'Thermostat card with a segmented step slider, compact mode and presets' });
