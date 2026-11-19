import type {StorybookConfig} from '@storybook/react-vite';
const config:StorybookConfig={stories:['../features/**/*.stories.tsx'],framework:'@storybook/react-vite',staticDirs:['../public'],typescript:{reactDocgen:false},core:{disableTelemetry:true},viteFinal:async config=>({...config,server:{...config.server,host:'127.0.0.1'}})};
export default config;
