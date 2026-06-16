export const metadata = {
  title: "Contrôle réception — BL CERP / Winpharma",
  description: "Réconciliation des bons de livraison CERP et de la réception Winpharma.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
