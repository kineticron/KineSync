/* eslint-disable no-unused-expressions -- Preserve the recovered reference verbatim. */
/* AMLL 0.5.2 InterludeDotsEl, recovered unchanged from main WebView bundle.
 * AGPL-3.0-only. Minimal DOM adapter is supplied by the native parity test. */
const W = { interludeDots: "dots", enabled: "enabled", playing: "playing" };
const Be = (value, min, max) => Math.min(Math.max(value, min), max);
const Ne = value => Be(value, 0, 1);
const Oe = value => Math.max(0, value);
  function u1(r) {
    let t = 2.5949095;
    return r < 0.5 ? (2 * r) ** 2 * ((t + 1) * 2 * r - t) / 2 : ((2 * r - 2) ** 2 * ((t + 1) * (r * 2 - 2) + t) + 2) / 2;
  }
  function d1(r) {
    return r === 1 ? 1 : 1 - 2 ** (-10 * r);
  }
  const ReferenceInterlude = class {
    element = document.createElement("div");
    dot0 = document.createElement("span");
    dot1 = document.createElement("span");
    dot2 = document.createElement("span");
    left = 0;
    top = 0;
    playing = true;
    lastStyle = "";
    currentInterlude;
    currentTime = 0;
    targetBreatheDuration = 1500;
    constructor() {
      this.element.className = W.interludeDots, this.element.appendChild(this.dot0), this.element.appendChild(this.dot1), this.element.appendChild(this.dot2);
    }
    getElement() {
      return this.element;
    }
    setTransform(r = this.left, t = this.top) {
      this.left = r, this.top = t, this.update();
    }
    setInterlude(r) {
      this.currentInterlude = r, this.currentTime = (r == null ? void 0 : r[0]) ?? 0, r ? this.element.classList.add(W.enabled) : this.element.classList.remove(W.enabled);
    }
    pause() {
      this.playing = false, this.element.classList.remove(W.playing);
    }
    resume() {
      this.playing = true, this.element.classList.add(W.playing);
    }
    update(r = 0) {
      if (!this.playing) return;
      this.currentTime += r;
      let t = "";
      if (t += `transform:translate(${this.left.toFixed(2)}px, ${this.top.toFixed(2)}px)`, this.currentInterlude) {
        let e = this.currentInterlude[1] - this.currentInterlude[0], i = this.currentTime - this.currentInterlude[0];
        if (i <= e) {
          let s = e / Math.ceil(e / this.targetBreatheDuration), n = 1, o = 1;
          n *= Math.sin(1.5 * Math.PI - i / s * 2) / 20 + 1, i < 2e3 && (n *= d1(i / 2e3)), i < 500 ? o = 0 : i < 1e3 && (o *= (i - 500) / 500), e - i < 750 && (n *= 1 - u1((750 - (e - i)) / 750 / 2)), e - i < 375 && (o *= Ne((e - i) / 375));
          let a = Oe(e - 750);
          n = Oe(n) * 0.7, t += ` scale(${n})`;
          let l = Be(0.25, i * 3 / a * 0.75, 1), h = Be(0.25, (i - a / 3) * 3 / a * 0.75, 1), c = Be(0.25, (i - a / 3 * 2) * 3 / a * 0.75, 1);
          this.dot0.style.opacity = `${Ne(o * l)}`, this.dot1.style.opacity = `${Ne(o * h)}`, this.dot2.style.opacity = `${Ne(o * c)}`;
        } else t += " scale(0)", this.dot0.style.opacity = "0", this.dot1.style.opacity = "0", this.dot2.style.opacity = "0";
        t += ";", this.lastStyle !== t && (this.element.setAttribute("style", t), this.lastStyle = t);
      }
    }
    dispose() {
      this.element.remove();
    }

};
module.exports = ReferenceInterlude;
