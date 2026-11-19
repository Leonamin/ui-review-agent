import type {ReactElement} from 'react';
import {Tooltip as RTooltip} from 'radix-ui';

export function Tooltip({label,children}:{label:string;children:ReactElement}) {
 return <RTooltip.Provider delayDuration={300}><RTooltip.Root>
  <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
  <RTooltip.Portal><RTooltip.Content className="viewer-tooltip" sideOffset={6} collisionPadding={16}>{label}</RTooltip.Content></RTooltip.Portal>
 </RTooltip.Root></RTooltip.Provider>;
}
