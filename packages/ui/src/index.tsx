import type { ReactNode } from "react";
import { Button as AstryxButton, type ButtonProps } from "@astryxdesign/core/Button";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export function AppTheme({ children }: { readonly children: ReactNode }) {
  return <Theme theme={neutralTheme} mode="light">{children}</Theme>;
}

export function AppButton(props: Readonly<ButtonProps>) {
  return <AstryxButton {...props} />;
}
