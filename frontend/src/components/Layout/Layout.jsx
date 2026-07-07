import React from 'react';
import Sidebar from './Sidebar';

const Layout = ({ children }) => (
  <div style={{ display: 'flex', minHeight: '100vh' }}>
    <Sidebar />
    <main style={{
      marginLeft: 'var(--sidebar-width)', flex: 1,
      padding: '2rem', minHeight: '100vh', overflowY: 'auto',
    }}>
      {children}
    </main>
  </div>
);

export default Layout;
