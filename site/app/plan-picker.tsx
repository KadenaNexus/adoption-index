'use client';
import { useState } from 'react';
import Link from 'next/link';
import { plans, type PlanId } from '../lib/billing-terms';

const notes: Record<PlanId, [string, string]> = { monthly: ['per month', 'cancel anytime'], annual: ['per year', 'save 27%'] };

// Native radio inputs give one tab stop and arrow-key selection for free.
export default function PlanPicker() {
  const [selected, setSelected] = useState<PlanId>('monthly');
  return <>
    <fieldset className="plan-options">
      <legend className="sr-only">Billing period</legend>
      {(Object.keys(plans) as PlanId[]).map(id => <label key={id} className="plan-option">
        <input className="sr-only" type="radio" name="plan" value={id} checked={selected === id} onChange={() => setSelected(id)}/>
        <span className="plan-name">{plans[id].name}</span>
        <span className="plan-price">${plans[id].price}</span>
        <span className="plan-note"><span>{notes[id][0]}</span><span className="plan-note-dot"> · </span><span>{notes[id][1]}</span></span>
      </label>)}
    </fieldset>
    <Link className="button-light" href={`/checkout?plan=${selected}`}>Get Pro access</Link>
  </>;
}
