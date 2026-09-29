import { TestMarkers } from "../_shared/markers.jsx";

export const metadata = { title: "nrc static-site", metadataBase: new URL("http://localhost") };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <TestMarkers />
        {children}
      </body>
    </html>
  );
}
