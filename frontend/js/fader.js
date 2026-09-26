// Dokunmatik fader.
//
// <input type="range"> telefonda kullanışsız: dokunma alanı ince, parmak
// kayınca bırakıyor, sayfa onunla birlikte kayıyor. Bu bileşen pointer
// event'leriyle yazıldı:
//   - touch-action: none  -> sürüklerken sayfa kaymıyor
//   - setPointerCapture    -> parmak elementten çıksa bile takip ediyor
//   - en az 44 px dokunma alanı (görsel çizgi ince, isabet alanı kalın)
//
// Erişilebilirlik bedava gelmiyor: role/aria ve ok tuşları elle eklendi.

const MIN_HIT_PX = 44;

export class Fader {
  constructor({ min = 0, max = 150, value = 100, step = 1, label = "", onInput }) {
    this.min = min;
    this.max = max;
    this.step = step;
    this.value = value;
    this.onInput = onInput;
    this.dragging = false;

    const root = document.createElement("div");
    root.className = "fader";
    root.tabIndex = 0;
    root.setAttribute("role", "slider");
    root.setAttribute("aria-label", label);
    root.setAttribute("aria-valuemin", String(min));
    root.setAttribute("aria-valuemax", String(max));

    const track = document.createElement("div");
    track.className = "fader-track";
    const fill = document.createElement("div");
    fill.className = "fader-fill";
    const knob = document.createElement("div");
    knob.className = "fader-knob";
    track.append(fill, knob);
    root.append(track);

    this.root = root;
    this.fill = fill;
    this.knob = knob;

    root.addEventListener("pointerdown", this.#onPointerDown);
    root.addEventListener("pointermove", this.#onPointerMove);
    root.addEventListener("pointerup", this.#onPointerUp);
    root.addEventListener("pointercancel", this.#onPointerUp);
    root.addEventListener("keydown", this.#onKeyDown);
    // Çift dokunuşla varsayılana dön: telefonda ince ayarı geri almak zor.
    root.addEventListener("dblclick", () => this.set(100, true));

    this.#render();
  }

  get element() {
    return this.root;
  }

  #valueFromEvent(event) {
    const rect = this.root.getBoundingClientRect();
    if (rect.width <= 0) return this.value;
    const ratio = (event.clientX - rect.left) / rect.width;
    const raw = this.min + ratio * (this.max - this.min);
    return Math.round(raw / this.step) * this.step;
  }

  #onPointerDown = (event) => {
    this.dragging = true;
    this.root.setPointerCapture(event.pointerId);
    this.root.focus({ preventScroll: true });
    this.set(this.#valueFromEvent(event), true);
    event.preventDefault();
  };

  #onPointerMove = (event) => {
    if (!this.dragging) return;
    this.set(this.#valueFromEvent(event), true);
    event.preventDefault();
  };

  #onPointerUp = (event) => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.root.hasPointerCapture(event.pointerId)) {
      this.root.releasePointerCapture(event.pointerId);
    }
  };

  #onKeyDown = (event) => {
    const big = event.shiftKey ? 10 : 1;
    const moves = {
      ArrowLeft: -big, ArrowDown: -big,
      ArrowRight: big, ArrowUp: big,
      PageDown: -10, PageUp: 10,
      Home: "min", End: "max",
    };
    if (!(event.key in moves)) return;
    const move = moves[event.key];
    if (move === "min") this.set(this.min, true);
    else if (move === "max") this.set(this.max, true);
    else this.set(this.value + move * this.step, true);
    event.preventDefault();
  };

  set(value, notify = false) {
    const clamped = Math.min(Math.max(value, this.min), this.max);
    if (clamped === this.value) {
      if (notify && this.onInput) this.onInput(clamped);
      return;
    }
    this.value = clamped;
    this.#render();
    if (notify && this.onInput) this.onInput(clamped);
  }

  setValueText(text) {
    this.root.setAttribute("aria-valuetext", text);
  }

  #render() {
    const ratio = (this.value - this.min) / (this.max - this.min);
    const percent = `${ratio * 100}%`;
    this.fill.style.width = percent;
    this.knob.style.left = percent;
    this.root.setAttribute("aria-valuenow", String(this.value));
  }
}

export { MIN_HIT_PX };
