import type { ReactNode } from "react";
import { Button as AstryxButton, type ButtonProps } from "@astryxdesign/core/Button";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export function AppTheme({ children }: { children: ReactNode }) {
  return <Theme theme={neutralTheme} mode="light">{children}</Theme>;
}

export function AppButton(props: ButtonProps) {
  return <AstryxButton {...props} />;
}
