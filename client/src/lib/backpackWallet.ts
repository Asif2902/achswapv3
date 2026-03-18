import type { Wallet } from '@rainbow-me/rainbowkit';
import { injected } from 'wagmi/connectors';

export interface BackpackWalletOptions {
  projectId: string;
}

export const backpackWallet = ({
  projectId,
}: BackpackWalletOptions): Wallet => ({
  id: 'backpack',
  name: 'Backpack',
  iconUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRskzMkaUu-zGm89qBtvWV7voyrivovJhTpI3VjbTrq_A&s',
  iconBackground: '#8697FF',
  rdns: 'app.backpack',
  downloadUrls: {
    chrome: 'https://chrome.google.com/webstore/detail/backpack/flpicaolkpkjcjhoiboagmoaohneibmf',
    browserExtension: 'https://backpack.app/download',
  },
  extension: {
    instructions: {
      learnMoreUrl: 'https://backpack.app/',
      steps: [
        {
          description: 'wallet_connectors.backpack.extension.step1.description',
          step: 'install',
          title: 'wallet_connectors.backpack.extension.step1.title',
        },
        {
          description: 'wallet_connectors.backpack.extension.step2.description',
          step: 'create',
          title: 'wallet_connectors.backpack.extension.step2.title',
        },
        {
          description: 'wallet_connectors.backpack.extension.step3.description',
          step: 'refresh',
          title: 'wallet_connectors.backpack.extension.step3.title',
        },
      ],
    },
  },
  createConnector: () => injected() as any,
});
