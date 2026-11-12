var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// scion:index.ts
var index_exports = {};
__export(index_exports, {
  description: () => description,
  name: () => name,
  parameters: () => parameters,
  run: () => run
});
module.exports = __toCommonJS(index_exports);

// scion:metrics.ts
function measure(text) {
  return { ok: true, words: (text.match(/\S+/g) || []).length, characters: Array.from(text).length };
}

// scion:index.ts
var name = "auma-text-metrics";
var description = "Count words and characters in supplied text";
var parameters = { type: "object", properties: { text: { type: "string" } } };
function run(args) {
  return measure(args.text ?? "");
}
