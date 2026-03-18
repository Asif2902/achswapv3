import { Wallet, getWalletConnectConnector } from '@rainbow-me/rainbowkit';

export interface BackpackWalletOptions {
  projectId: string;
}

export const backpackWallet = ({
  projectId,
}: BackpackWalletOptions): Wallet => ({
  id: 'backpack',
  name: 'Backpack',
  iconUrl: 'https://raw.githubusercontent.com/backpack/app/main/apps/xnft/public/logo.png',
  iconBackground: '#000',
  iconAccent: '#fff',
  downloadUrls: {
    chrome: 'https://chrome.google.com/webstore/detail/backpack/flpicaolkpkjcjhoiboagmoaohneibmf',
    browserExtension: 'https://backpack.app/download',
    qrCode: 'https://backpack.app/download',
  },
  mobile: {
    getUri: (uri: string) => uri,
  },
  qrCode: {
    getUri: (uri: string) => uri,
    instructions: {
      learnMoreUrl: 'https://backpack.app/learn-more',
      steps: [
        {
          description:
            'We recommend putting Backpack Wallet on your home screen for faster access to your wallet.',
          step: 'install',
          title: 'Open the Backpack Wallet Extension',
        },
        {
          description:
            'After you scan, a connection prompt will appear for you to connect your wallet.',
          step: 'scan',
          title: 'Tap the scan button',
        },
      ],
    },
  },
  extension: {
    instructions: {
      learnMoreUrl: 'https://backpack.app/learn-more',
      steps: [
        {
          description:
            'Once you set up your wallet, click below to refresh the browser and load up the extension.',
          step: 'install',
          title: 'Install the Backpack Extension',
        },
        {
          description:
            'Create a new wallet or import an existing one. Your wallet will be detected automatically.',
          step: 'create',
          title: 'Create or Import a Wallet',
        },
        {
          description:
            'Once you set up your wallet, click below to refresh the browser and load up the extension.',
          step: 'refresh',
          title: 'Refresh the Browser',
        },
      ],
    },
  },
  createConnector: getWalletConnectConnector({ projectId }),
});
