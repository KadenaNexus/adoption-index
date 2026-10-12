import type { Metadata } from 'next';
import './globals.css';
const title = 'Kadena Community Edition Adoption Index';
const description = 'Five weighted signals. One daily measure of Kadena Community Edition adoption, with a transparent methodology and permanently retained daily history.';
export const metadata: Metadata = {title: `${title} | Kadena Nexus`, description, icons:{icon:[{url:'/favicon.ico',sizes:'any'},{url:'/favicon.svg',type:'image/svg+xml'}]}, metadataBase:new URL('https://adoption.kadena.ws'), openGraph:{title,description,type:'website',url:'https://adoption.kadena.ws/',images:[{url:'https://kadena.ws/og/og-adoption.jpg',width:1200,height:630,alt:'Kadena Adoption Index: one daily number for Kadena Community Edition adoption'}]}, twitter:{card:'summary_large_image',title,images:['https://kadena.ws/og/og-adoption.jpg']}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body><a href="#main-content" className="skip-link">Skip to content</a>{children}</body></html>}
