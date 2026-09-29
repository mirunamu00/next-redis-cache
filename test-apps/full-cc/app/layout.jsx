export const metadata = { title: "nrc full-cc", metadataBase: new URL("http://localhost") };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
