'use client';
import { KBarAnimator, KBarPortal, KBarPositioner, KBarProvider, KBarSearch, useKBar, useRegisterActions } from 'kbar';
import { Kbd, SEARCH_SCOPE } from './ui';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import RenderResults from './render-result';
import { AskAiAction, AskAiProvider } from './ask-ai';
import { searchActions } from './actions';
import { usePlatformSearchSources, useSearchSources } from './sources';
import type { AskArea } from '@/lib/ask-answer';
import { platformSearchIndex, searchIndex, type SearchItem } from '@/lib/studio-search';

/**
 * The Cmd+K bar: in Studio its pages, the workspace's apps (typing finds an app's tabs), the user's financial products,
 * members and audit actions; in the platform admin (`area` "admin") its sections, every workspace and regulated firm,
 * and Studio's pages. And "Ask AI" for a question (./ask-ai.tsx). What it lists is loaded when the bar opens
 * (./sources.ts) and built by lib/studio-search.ts.
 */
export default function KBar({ area = 'studio', children }: { area?: AskArea; children: React.ReactNode }) {
  return (
    <KBarProvider actions={[]}>
      <AskAiProvider area={area}>
        <AskAiAction area={area} />
        {area === 'admin' ? <PlatformActions /> : <StudioActions />}
        <KBarComponent>{children}</KBarComponent>
      </AskAiProvider>
    </KBarProvider>
  );
}

const useBarOpen = () => useKBar((s) => ({ open: s.visualState !== 'hidden' })).open;

// These action are for the navigation
function useNavigation(area: AskArea, items: SearchItem[]) {
  const router = useRouter();
  const actions = useMemo(() => {
    // Define navigateTo inside the useMemo callback to avoid dependency array issues
    const navigateTo = (url: string) => {
      router.push(url);
    };
    return searchActions(area, items).map(({ href, ...action }) => (href ? { ...action, perform: () => navigateTo(href) } : action));
  }, [router, area, items]);
  useRegisterActions(actions, [actions]);
}

function StudioActions() {
  const sources = useSearchSources(useBarOpen());
  useNavigation('studio', useMemo(() => searchIndex(sources), [sources]));
  return null;
}

function PlatformActions() {
  const sources = usePlatformSearchSources(useBarOpen());
  useNavigation('admin', useMemo(() => platformSearchIndex(sources), [sources]));
  return null;
}

/** The bar's foot: what the keys do. */
export function KBarFooter() {
  return (
    <div className='text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-xs'>
      <span className='flex items-center gap-1'>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> navigate
      </span>
      <span className='flex items-center gap-1'>
        <Kbd>↵</Kbd> open
      </span>
      <span className='flex items-center gap-1'>
        <Kbd>esc</Kbd> close
      </span>
    </div>
  );
}

const KBarComponent = ({ children }: { children: React.ReactNode }) => {

  return (
    <>
      <KBarPortal>
        <KBarPositioner className={`${SEARCH_SCOPE} bg-black/10 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-99999 flex items-start! justify-center p-4! pt-[14vh]!`}>
          <KBarAnimator className='bg-popover text-popover-foreground ring-foreground/10 relative mx-auto w-full max-w-[600px] overflow-hidden rounded-xl shadow-lg ring-1'>
            <div className='bg-popover sticky top-0 z-10 border-b'>
              <KBarSearch className='placeholder:text-muted-foreground w-full border-none bg-transparent px-4 py-3.5 text-sm outline-hidden focus:ring-0 focus:outline-hidden' />
            </div>
            <div className='h-[400px]'>
              <RenderResults />
            </div>
            <KBarFooter />
          </KBarAnimator>
        </KBarPositioner>
      </KBarPortal>
      {children}
    </>
  );
};
