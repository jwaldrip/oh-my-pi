import "./rnw.ts";

import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// This must load after rnw.ts registers the test-only react-native adapter.
const { Text, View } = await import("react-native");

test("the RNW test adapter and React DOM share one React dispatcher", () => {
  expect(renderToStaticMarkup(createElement(View, null, createElement(Text, null, "ready")))).toContain("ready");
});
