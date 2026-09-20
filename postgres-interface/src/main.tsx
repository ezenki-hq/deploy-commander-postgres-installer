import { createRoot } from 'react-dom/client';
import App from './app/App';
import { createInterfaceClient } from './platform/interfaceClient';
import './styles.css';
const client = createInterfaceClient();
createRoot(document.getElementById('root')!).render(<App client={client} />);
