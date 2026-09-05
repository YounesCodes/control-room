import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://younescodes.github.io',
  base: '/control-room',
  integrations: [
    starlight({
      title: 'Control Room docs',
      description: 'Documentation for the Windows SSH client with read-only Linux host inspection.',
      logo: {
        src: './src/assets/app-icon.svg',
        alt: 'Control Room app icon',
      },
      favicon: '/app-icon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/YounesCodes/control-room',
        },
      ],
      customCss: ['./src/styles/custom.css'],
      editLink: {
        baseUrl: 'https://github.com/YounesCodes/control-room/edit/main/docs/',
      },
      disable404Route: true,
      lastUpdated: true,
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', slug: 'start-here/introduction' },
            { label: 'Installation', slug: 'start-here/installation' },
            { label: 'Quick start', slug: 'start-here/quick-start' },
            { label: 'Requirements and support', slug: 'start-here/requirements' },
          ],
        },
        {
          label: 'Use Control Room',
          items: [
            { label: 'Connections', slug: 'connections' },
            { label: 'Terminal', slug: 'terminal' },
            { label: 'Local terminals', slug: 'local-terminals' },
            { label: 'Workspaces', slug: 'workspaces' },
          ],
        },
        {
          label: 'Inspect a host',
          items: [
            { label: 'Host overview', slug: 'inspection/overview' },
            { label: 'Services', slug: 'inspection/services' },
            { label: 'Logs', slug: 'inspection/logs' },
            { label: 'Docker', slug: 'inspection/docker' },
            { label: 'Ports and networking', slug: 'inspection/ports' },
            { label: 'Boot diagnostics', slug: 'inspection/boot' },
            { label: 'Host baselines', slug: 'inspection/baselines' },
            { label: 'Enhanced History', slug: 'inspection/history' },
            { label: 'Scratchpad', slug: 'inspection/scratchpad' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Settings', slug: 'reference/settings' },
            { label: 'Keyboard shortcuts', slug: 'reference/keyboard-shortcuts' },
            { label: 'Security and data', slug: 'reference/security' },
          ],
        },
        {
          label: 'Help',
          items: [
            { label: 'Troubleshooting', slug: 'help/troubleshooting' },
            { label: 'FAQ', slug: 'help/faq' },
          ],
        },
        {
          label: 'Development',
          items: [
            { label: 'Development setup', slug: 'development/setup' },
            { label: 'Architecture', slug: 'development/architecture' },
            { label: 'Contributing', slug: 'development/contributing' },
          ],
        },
      ],
    }),
  ],
});
