import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { Measured } from '@/components/Measured';
import { AgentPrompt } from '@/components/AgentPrompt';
import { Tour } from '@/components/Tour';
import { HowItWorks } from '@/components/HowItWorks';
import { Harness } from '@/components/Harness';
import { Numbers } from '@/components/Numbers';
import { PriorArt, Footer } from '@/components/PriorArt';

export default function App() {
  return (
    <div id="top">
      <a
        href="#agent-prompt"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[8px] focus:bg-ash focus:px-4 focus:py-2 focus:text-charcoal"
      >
        Skip to the agent quick-install prompt
      </a>
      <Nav />
      <main>
        <Hero />
        <Measured />
        <AgentPrompt />
        <Tour />
        <HowItWorks />
        <Harness />
        <Numbers />
        <PriorArt />
      </main>
      <Footer />
    </div>
  );
}
