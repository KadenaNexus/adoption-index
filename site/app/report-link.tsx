import Link from 'next/link';
import { Flag } from 'lucide-react';
import { indicatorLabel, reportHref, type ReportIndicator } from '../lib/report';

// The small "Report a data issue" link beside an indicator (or a group of them, with no indicator chosen). The hidden
// suffix tells the links apart for screen readers.
export default function ReportLink({ indicator }: { indicator?: ReportIndicator }) {
  const about = !indicator ? 'an indicator' : indicator === 'index' ? 'the index score' : indicatorLabel(indicator);
  return <Link className="report-link" href={reportHref(indicator)}><Flag size={12} aria-hidden="true"/>Report a data issue<span className="sr-only"> about {about}</span></Link>;
}
