import type { Metadata } from 'next';
import './globals.css';
const title = 'Kadena Community Edition Adoption Index';
const description = 'Five weighted signals. One daily measure of Kadena Community Edition adoption, with a transparent methodology and permanently retained daily history.';
export const metadata: Metadata = {title: `${title} | Kadena Nexus`, description, icons:{icon:[{url:'/favicon.ico',sizes:'any'},{url:'/favicon.svg',type:'image/svg+xml'}]}, openGraph:{title,description,type:'website'}, twitter:{card:'summary',title}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body><a href="#main-content" className="skip-link">Skip to content</a>{children}</body></html>}
