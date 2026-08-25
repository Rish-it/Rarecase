import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Rarecase",
  description:
    "Turn elusive production bugs into reproducible tests, verified fixes, and human-approved pull requests.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
