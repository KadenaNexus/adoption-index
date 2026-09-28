import type { Metadata } from 'next';
import Home from '../page';
export const metadata: Metadata = { title: 'Kadena Community Edition Adoption Index', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
export default Home;
