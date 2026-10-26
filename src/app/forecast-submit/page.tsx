import { redirect } from 'next/navigation'

// Merged into the Forecast tabs page; kept so old links and bookmarks still work.
export default function Page() {
  redirect('/forecast#submit')
}
